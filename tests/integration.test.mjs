/**
 * Drives background.js runSync() end to end against a stubbed Chrome and a fake Calendar API:
 * scrape → parse → filter → diff → HTTP. This is what catches wiring bugs that unit tests miss.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { courseHtml, installChromeStub, installFakeCalendar } from './helpers/chrome-stub.mjs';

let runSync, parseAssignments;
let ctx, cal, scrapePayload;

const COURSES = [
  { id: '612345', shortName: 'CS 121', name: 'Theoretical CS', term: 'Fall 2026', role: 'student', url: 'https://www.gradescope.com/courses/612345' },
];

/** Build a GS_SCRAPE_RESULT the way scrape.js would, from real HTML through the real parser. */
async function scrapeFrom(rows, { ok = true, reason = null, courseOk = true } = {}) {
  if (!ok) return { ok: false, reason };
  const parsed = parseAssignments(courseHtml(rows), '612345');
  return {
    ok: true,
    courses: COURSES,
    results: [
      courseOk
        ? { courseId: '612345', ok: true, reason: null, assignments: parsed.assignments, warnings: [] }
        : { courseId: '612345', ok: false, reason: 'no-assignment-table', assignments: [] },
    ],
    warnings: [],
  };
}

before(async () => {
  const { DOMParser } = await import('linkedom');
  globalThis.DOMParser = DOMParser;
  ({ parseAssignments } = await import('../src/parse.js'));

  ctx = installChromeStub({ scrapeResultFor: () => scrapePayload });
  cal = installFakeCalendar();
  ({ runSync } = await import('../src/background.js'));
});

beforeEach(() => {
  cal.log.length = 0;
});

test('first sync creates the calendar and writes only future, unsubmitted deadlines', async () => {
  scrapePayload = await scrapeFrom([
    { id: '1', name: 'Problem Set 2', inDays: 8 },
    { id: '2', name: 'Lab 3', inDays: 3 },
    { id: '3', name: 'Problem Set 1', inDays: -5 }, // past
    { id: '4', name: 'Quiz 1', inDays: 5, submitted: true }, // already handed in
  ]);

  const res = await runSync({ interactive: true, trigger: 'test' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.summary.created, 2);
  assert.equal(res.summary.deleted, 0);
  assert.equal(cal.state.events.size, 2);

  const summaries = [...cal.state.events.values()].map((e) => e.summary).sort();
  assert.deepEqual(summaries, ['CS 121 — Lab 3', 'CS 121 — Problem Set 2']);

  const ev = [...cal.state.events.values()][0];
  assert.ok(ev.start.date && !ev.start.dateTime, 'all-day event');
  assert.equal(ctx.calls.tabsCreated, 1);
  assert.equal(ctx.calls.tabsRemoved, 1, 'the scraping tab is cleaned up');
  assert.ok(cal.log.includes('POST /calendars'), 'created its own calendar');
});

test('an unchanged second run makes zero write calls', async () => {
  const res = await runSync({ interactive: false, trigger: 'test' });
  assert.equal(res.ok, true);
  assert.deepEqual([res.summary.created, res.summary.updated, res.summary.deleted], [0, 0, 0]);
  assert.equal(res.summary.unchanged, 2);
  assert.equal(cal.log.filter((l) => /^(PUT|POST|DELETE) \/calendars\/[^/]+\/events/.test(l)).length, 0);
});

test('a moved deadline updates the same event instead of duplicating it', async () => {
  const before = [...cal.state.events.keys()].sort();
  scrapePayload = await scrapeFrom([
    { id: '1', name: 'Problem Set 2', inDays: 12 }, // pushed back
    { id: '2', name: 'Lab 3', inDays: 3 },
  ]);
  const res = await runSync({ interactive: false, trigger: 'test' });
  assert.equal(res.summary.updated, 1);
  assert.equal(res.summary.created, 0);
  assert.equal(cal.state.events.size, 2, 'no duplicate');
  assert.deepEqual([...cal.state.events.keys()].sort(), before, 'same event ids');
});

test('submitting an assignment removes its event', async () => {
  scrapePayload = await scrapeFrom([
    { id: '1', name: 'Problem Set 2', inDays: 12, submitted: true },
    { id: '2', name: 'Lab 3', inDays: 3 },
  ]);
  const res = await runSync({ interactive: false, trigger: 'test' });
  assert.equal(res.summary.deleted, 1);
  assert.equal(cal.state.events.size, 1);
  assert.equal([...cal.state.events.values()][0].summary, 'CS 121 — Lab 3');
});

test('FAILURE GUARD: a course that fails to parse deletes nothing', async () => {
  const before = new Set(cal.state.events.keys());
  scrapePayload = await scrapeFrom([], { courseOk: false });
  const res = await runSync({ interactive: false, trigger: 'test' });
  assert.equal(res.ok, true);
  assert.equal(res.summary.deleted, 0);
  assert.deepEqual(new Set(cal.state.events.keys()), before, 'events survive a broken scrape');
  assert.equal(res.summary.failedCourses, 1);
  assert.ok(ctx.calls.notifications.some((n) => /warning/i.test(n.title)));
});

test('a logged-out scrape surfaces the tab, warns, and writes nothing', async () => {
  const before = new Set(cal.state.events.keys());
  scrapePayload = await scrapeFrom([], { ok: false, reason: 'not-logged-in' });
  const res = await runSync({ interactive: false, trigger: 'test' });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'not-logged-in');
  assert.deepEqual(new Set(cal.state.events.keys()), before);
  assert.equal(ctx.store.lastSyncStatus, 'login-required');
  assert.ok(ctx.calls.activated.length > 0, 'the sign-in tab is brought to the front');
  assert.ok(ctx.calls.notifications.some((n) => /sign in/i.test(n.title)));
});

test('dry run reports a plan without touching the calendar', async () => {
  await chrome.storage.local.set({ settings: { ...(await chrome.storage.local.get('settings')).settings, dryRun: true } });
  const before = new Set(cal.state.events.keys());
  scrapePayload = await scrapeFrom([{ id: '9', name: 'New Assignment', inDays: 4 }]);

  const res = await runSync({ interactive: false, trigger: 'test' });
  assert.equal(res.dryRun, true);
  assert.deepEqual(new Set(cal.state.events.keys()), before, 'nothing written');
  assert.equal(cal.log.filter((l) => /events/.test(l)).length, 0);
});

test('the user consents exactly once, then tokens refresh silently', async () => {
  // The first sync above ran the interactive flow.
  assert.equal(ctx.calls.authFlows.length, 1, 'one consent window, at the first sync');
  assert.match(ctx.calls.authFlows[0], /accounts\.google\.com/);

  const first = cal.tokenGrants[0];
  assert.equal(first.grant_type, 'authorization_code');
  assert.ok(first.code_verifier, 'PKCE verifier accompanies the exchange');
  assert.equal(first.redirect_uri, 'https://testextensionid.chromiumapp.org/');

  const stored = (await chrome.storage.local.get('googleAuth')).googleAuth;
  assert.equal(stored.refreshToken, 'fake-refresh-token', 'refresh token is persisted');

  // Later syncs reused the cached access token rather than re-hitting Google.
  assert.equal(cal.tokenGrants.length, 1, 'no redundant token calls while the token is valid');

  // Expire it, the way a real hour-old token would be.
  await chrome.storage.local.set({ googleAuth: { ...stored, expiresAt: Date.now() - 1000 } });
  await chrome.storage.local.set({ settings: { ...(await chrome.storage.local.get('settings')).settings, dryRun: false } });

  scrapePayload = await scrapeFrom([{ id: '2', name: 'Lab 3', inDays: 3 }]);
  const res = await runSync({ interactive: false, trigger: 'test' });

  assert.equal(res.ok, true, res.error);
  assert.equal(ctx.calls.authFlows.length, 1, 'a background sync must never pop a consent window');
  assert.equal(cal.tokenGrants.at(-1).grant_type, 'refresh_token', 'it refreshed instead');
});

test('a revoked refresh token fails the background sync instead of hanging on a prompt', async () => {
  await chrome.storage.local.remove('googleAuth');
  scrapePayload = await scrapeFrom([{ id: '2', name: 'Lab 3', inDays: 3 }]);

  const res = await runSync({ interactive: false, trigger: 'test' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'google-auth-required');
  assert.equal(ctx.calls.authFlows.length, 1, 'still no surprise popup');
  assert.ok(ctx.calls.notifications.some((n) => /reconnect/i.test(n.title)), 'it tells the user instead');
});
