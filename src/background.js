/**
 * Service worker: schedules the sync, drives the Gradescope tab, writes the calendar.
 */
import { getState, setState, mergeCourses, resetSyncState } from './storage.js';
import { buildEvent, diff, selectAssignments } from './sync.js';
import { AuthError, deleteEvent, ensureCalendar, getToken, revokeToken, upsertEvent } from './gcal.js';

const ALARM = 'gradescope-daily-sync';
const ACCOUNT_URL = 'https://www.gradescope.com/account';
const SCRAPE_TIMEOUT_MS = 180000;
const STALE_LOCK_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- scheduling

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM);
  if (!existing) chrome.alarms.create(ALARM, { periodInMinutes: 1440, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) runSync({ interactive: false, trigger: 'alarm' });
});

// ---------------------------------------------------------------- scraping

const pendingScrapes = new Map(); // tabId -> { resolve }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'GS_SCRAPE_RESULT') {
    const pending = pendingScrapes.get(sender.tab?.id);
    if (pending) {
      pendingScrapes.delete(sender.tab.id);
      pending.resolve(msg);
    }
    return false;
  }

  if (msg?.type === 'SYNC_NOW') {
    runSync({ interactive: true, trigger: 'manual' }).then(sendResponse);
    return true;
  }
  if (msg?.type === 'CONNECT_GOOGLE') {
    getToken({ interactive: true })
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, error: e.message }))
      .then(sendResponse);
    return true;
  }
  if (msg?.type === 'DISCONNECT') {
    revokeToken()
      .then(() => setState({ calendarId: null }))
      .then(resetSyncState)
      .then(() => ({ ok: true }))
      .then(sendResponse);
    return true;
  }
  if (msg?.type === 'GET_STATUS') {
    Promise.all([
      getState(),
      // interactive:false never shows UI, so this is a safe "are we connected?" probe
      getToken({ interactive: false }).then(() => true).catch(() => false),
      chrome.alarms.get(ALARM),
    ]).then(([state, authOk, alarm]) =>
      sendResponse({ ...state, authOk, nextSyncAt: alarm?.scheduledTime ?? null }),
    );
    return true;
  }
  return false;
});

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function scrapeGradescope() {
  const tab = await chrome.tabs.create({ url: ACCOUNT_URL, active: false });
  let keepTab = false;
  try {
    await waitForTabLoad(tab.id);

    const result = await new Promise((resolve) => {
      let timer;
      // Every exit path goes through settle(), so the timeout never outlives the scrape and
      // keep the service worker alive for three minutes after we are done.
      const settle = (value) => {
        clearTimeout(timer);
        pendingScrapes.delete(tab.id);
        resolve(value);
      };

      timer = setTimeout(() => settle({ ok: false, reason: 'scrape-timeout' }), SCRAPE_TIMEOUT_MS);
      pendingScrapes.set(tab.id, { resolve: settle });

      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ['src/scrape.js'] })
        .catch((err) => settle({ ok: false, reason: `inject-failed: ${err.message}` }));
    });

    // Leave the tab up so a single click gets them signed back in.
    if (!result.ok && result.reason === 'not-logged-in') {
      keepTab = true;
      await chrome.tabs.update(tab.id, { active: true });
    }
    return result;
  } finally {
    if (!keepTab) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        /* already closed */
      }
    }
  }
}

// ---------------------------------------------------------------- sync

let syncing = false;

export async function runSync({ interactive = false, trigger = 'manual' } = {}) {
  const state = await getState();

  if (syncing || (state.syncStartedAt && Date.now() - state.syncStartedAt < STALE_LOCK_MS)) {
    return { ok: false, error: 'A sync is already running.' };
  }
  syncing = true;
  await setState({ syncStartedAt: Date.now() });

  try {
    const scrape = await scrapeGradescope();

    if (!scrape.ok) {
      if (scrape.reason === 'not-logged-in') {
        await finish({ status: 'login-required', error: null });
        notify('Sign in to Gradescope', 'Your session expired. Sign in, then sync again.');
        return { ok: false, error: 'not-logged-in' };
      }
      await finish({ status: 'error', error: scrape.reason });
      notify('Gradescope sync failed', String(scrape.reason));
      return { ok: false, error: scrape.reason };
    }

    const courses = await mergeCourses(scrape.courses);
    const courseById = new Map(courses.map((c) => [c.id, c]));

    // Only courses that parsed cleanly may have their events deleted.
    const deletableCourseIds = scrape.results.filter((r) => r.ok).map((r) => String(r.courseId));
    const failedCourses = scrape.results.filter((r) => !r.ok);
    const assignments = scrape.results.flatMap((r) => (r.ok ? r.assignments : []));

    let token;
    try {
      token = await getToken({ interactive });
    } catch (e) {
      await finish({ status: 'error', error: 'google-auth-required' });
      if (!interactive) notify('Reconnect Google Calendar', 'Open the extension and click Connect Google.');
      return { ok: false, error: e instanceof AuthError ? 'google-auth-required' : e.message };
    }
    void token;

    const timeZone = state.calendarTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const cal = await ensureCalendar({
      calendarId: state.calendarId,
      name: state.settings.calendarName,
      timeZone,
      interactive,
    });
    await setState({ calendarId: cal.calendarId, calendarTimeZone: cal.timeZone });

    const kept = selectAssignments({
      assignments,
      timeZone: cal.timeZone,
      settings: state.settings,
      now: new Date(),
    });

    const desired = [];
    for (const assignment of kept) {
      desired.push(
        await buildEvent({
          assignment,
          course: courseById.get(String(assignment.courseId)),
          timeZone: cal.timeZone,
          settings: state.settings,
        }),
      );
    }

    const plan = diff({ desired, synced: state.synced, deletableCourseIds });

    if (state.settings.dryRun) {
      console.log('[gs-sync] DRY RUN', {
        courses: courses.length,
        scraped: assignments.length,
        kept: kept.length,
        writes: plan.writes.map((w) => w.event.summary + ' @ ' + w.event.start.date),
        deletes: plan.deletes.map((d) => d.id),
        unchanged: plan.unchanged.length,
        kept_because_course_failed: plan.orphaned.length,
        failedCourses,
      });
      await finish({
        status: 'ok',
        error: null,
        summary: {
          dryRun: true,
          courses: courses.length,
          assignments: kept.length,
          created: 0,
          updated: plan.writes.length,
          deleted: plan.deletes.length,
          unchanged: plan.unchanged.length,
        },
      });
      return { ok: true, dryRun: true, plan: plan.writes.length + plan.deletes.length };
    }

    let created = 0;
    let updated = 0;
    let deleted = 0;
    const synced = { ...state.synced };

    for (const w of plan.writes) {
      const action = await upsertEvent(cal.calendarId, w.event);
      if (action === 'created') created += 1;
      else updated += 1;
      synced[w.id] = { hash: w.hash, courseId: w.courseId, assignmentId: w.event.extendedProperties.private.gsAssignmentId, dueISO: w.dueISO };
      await setState({ synced }); // checkpoint: a killed worker resumes, never double-writes
    }

    for (const d of plan.deletes) {
      await deleteEvent(cal.calendarId, d.id);
      delete synced[d.id];
      deleted += 1;
      await setState({ synced });
    }

    const summary = {
      courses: courses.length,
      assignments: kept.length,
      created,
      updated,
      deleted,
      unchanged: plan.unchanged.length,
      failedCourses: failedCourses.length,
    };
    await finish({ status: 'ok', error: null, summary });

    if (failedCourses.length) {
      notify(
        'Synced, with warnings',
        `${failedCourses.length} course page(s) could not be read. Their existing events were left alone.`,
      );
    }
    return { ok: true, summary };
  } catch (err) {
    console.error('[gs-sync]', err);
    await finish({ status: 'error', error: err?.message ?? String(err) });
    notify('Gradescope sync failed', err?.message ?? String(err));
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    syncing = false;
    await setState({ syncStartedAt: null });
  }
}

async function finish({ status, error, summary = null }) {
  await setState({
    lastSyncAt: Date.now(),
    lastSyncStatus: status,
    lastError: error,
    ...(summary ? { lastSummary: summary } : {}),
  });
  const bad = status === 'error' || status === 'login-required';
  await chrome.action.setBadgeText({ text: bad ? '!' : '' });
  if (bad) await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
  });
}
