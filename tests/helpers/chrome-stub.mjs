/**
 * Minimal in-memory chrome.* + a fake Google Calendar server, enough to run background.js
 * end to end under node:test. Records every API call so tests can assert on the wire traffic.
 */

export function installChromeStub({ scrapeResultFor }) {
  const store = {};
  const listeners = { message: [], alarm: [], installed: [], startup: [], tabUpdated: [] };
  const calls = { tabsCreated: 0, tabsRemoved: 0, injected: 0, notifications: [], activated: [], authFlows: [] };

  let nextTabId = 100;

  const chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      sendMessage: async () => undefined,
      openOptionsPage: () => {},
    },
    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) return structuredClone(store);
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]),
          );
        },
        async set(patch) {
          Object.assign(store, structuredClone(patch));
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        },
      },
    },
    alarms: {
      async get() {
        return { name: 'gradescope-daily-sync', scheduledTime: Date.now() + 86400000 };
      },
      create: () => {},
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    tabs: {
      async create() {
        const id = nextTabId++;
        calls.tabsCreated += 1;
        // setTimeout, not a microtask: background.js registers its onUpdated listener only
        // after awaiting tabs.create, so a microtask would fire before anyone is listening.
        setTimeout(() => listeners.tabUpdated.forEach((fn) => fn(id, { status: 'complete' })), 5);
        return { id };
      },
      async remove() {
        calls.tabsRemoved += 1;
      },
      async update(id, info) {
        if (info.active) calls.activated.push(id);
      },
      onUpdated: {
        addListener: (fn) => listeners.tabUpdated.push(fn),
        removeListener: (fn) => {
          listeners.tabUpdated = listeners.tabUpdated.filter((f) => f !== fn);
        },
      },
    },
    scripting: {
      async executeScript({ target }) {
        calls.injected += 1;
        const payload = await scrapeResultFor();
        queueMicrotask(() =>
          listeners.message.forEach((fn) =>
            fn({ type: 'GS_SCRAPE_RESULT', ...payload }, { tab: { id: target.tabId } }, () => {}),
          ),
        );
        return [];
      },
    },
    identity: {
      getRedirectURL: () => 'https://testextensionid.chromiumapp.org/',
      launchWebAuthFlow: ({ url }, cb) => {
        calls.authFlows.push(url);
        cb('https://testextensionid.chromiumapp.org/?code=fake-auth-code');
      },
    },
    notifications: {
      create: (opts) => calls.notifications.push(opts),
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
  };

  globalThis.chrome = chrome;
  return { store, calls, listeners };
}

/** A fake Calendar API that behaves like the real one for the verbs we use. */
export function installFakeCalendar() {
  const state = { calendars: new Map(), events: new Map() };
  const log = [];
  const tokenGrants = [];

  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';

    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      const form = new URLSearchParams(opts.body);
      log.push(`POST /token (${form.get('grant_type')})`);
      tokenGrants.push(Object.fromEntries(form));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: `access-${tokenGrants.length}`,
            expires_in: 3600,
            ...(form.get('grant_type') === 'authorization_code'
              ? { refresh_token: 'fake-refresh-token' }
              : {}),
          }),
      };
    }
    if (String(url).startsWith('https://oauth2.googleapis.com/revoke')) {
      log.push('POST /revoke');
      return { ok: true, status: 200, text: async () => '{}' };
    }

    const path = String(url).replace('https://www.googleapis.com/calendar/v3', '');
    log.push(`${method} ${path}`);
    const body = opts.body ? JSON.parse(opts.body) : null;
    const json = (status, obj) => ({
      ok: status < 400,
      status,
      json: async () => obj,
      text: async () => JSON.stringify(obj),
    });

    if (method === 'POST' && path === '/calendars') {
      const id = 'cal-gradescope';
      state.calendars.set(id, { id, ...body });
      return json(200, { id, timeZone: body.timeZone });
    }
    const calMatch = path.match(/^\/calendars\/([^/]+)$/);
    if (method === 'GET' && calMatch) {
      const cal = state.calendars.get(decodeURIComponent(calMatch[1]));
      return cal ? json(200, cal) : json(404, { error: 'not found' });
    }
    if (method === 'PATCH' && path.startsWith('/users/me/calendarList/')) return json(200, {});

    const evMatch = path.match(/^\/calendars\/([^/]+)\/events(?:\/(.+))?$/);
    if (evMatch) {
      const eventId = evMatch[2];
      if (method === 'PUT') {
        if (!state.events.has(eventId)) return json(404, { error: 'not found' });
        state.events.set(eventId, body);
        return json(200, body);
      }
      if (method === 'POST') {
        if (state.events.has(body.id)) return json(409, { error: 'duplicate' });
        state.events.set(body.id, body);
        return json(200, body);
      }
      if (method === 'DELETE') {
        if (!state.events.has(eventId)) return json(404, { error: 'not found' });
        state.events.delete(eventId);
        return json(204, {});
      }
    }
    return json(500, { error: `unhandled ${method} ${path}` });
  };

  return { state, log, tokenGrants };
}

/** Builds a course page with deadlines relative to now, so tests never rot. */
export function courseHtml(rows) {
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00 ` +
    (d.getTimezoneOffset() > 0 ? '-' : '+') +
    String(Math.floor(Math.abs(d.getTimezoneOffset()) / 60)).padStart(2, '0') +
    String(Math.abs(d.getTimezoneOffset()) % 60).padStart(2, '0');

  const body = rows
    .map((r) => {
      const due = new Date(Date.now() + r.inDays * 86400000);
      due.setHours(23, 59, 0, 0);
      return `
      <tr role="row">
        <th class="table--primaryLink"><button class="js-submitAssignment" data-assignment-id="${r.id}">${r.name}</button></th>
        <td class="submissionStatus">${
          r.submitted
            ? '<div class="submissionStatus--score">10 / 10</div>'
            : '<div class="submissionStatus--text">No Submission</div>'
        }</td>
        <td><div class="progressBar"><span class="submissionTimeChart--dueDate" datetime="${fmt(due)}"></span></div></td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html><html><body><table id="assignments-student-table"><tbody>${body}</tbody></table></body></html>`;
}
