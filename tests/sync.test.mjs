import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  buildEvent,
  diff,
  dueDateFor,
  eventIdFor,
  localDateString,
  selectAssignments,
} from '../src/sync.js';

const TZ = 'America/New_York';
const SETTINGS = { skipSubmitted: true, skipPast: true, shiftMidnight: true, reminderMinutes: 900 };

const a = (over = {}) => ({
  courseId: '612345',
  assignmentId: '3900002',
  name: 'Problem Set 2',
  url: 'https://www.gradescope.com/courses/612345/assignments/3900002',
  dueISO: '2026-09-13T03:59:00.000Z', // 2026-09-12 23:59 EDT
  lateDueISO: null,
  submitted: false,
  ...over,
});

const course = { id: '612345', shortName: 'CS 121', name: 'Introduction to Theoretical CS' };

test('event ids are deterministic, legal and collision-free per assignment', async () => {
  const id = await eventIdFor('612345', '3900002');
  assert.match(id, /^[a-v0-9]{5,1024}$/, 'Google only accepts base32hex-ish ids');
  assert.equal(id, await eventIdFor('612345', '3900002'), 'stable across runs');
  assert.notEqual(id, await eventIdFor('612345', '3900003'));
  assert.notEqual(id, await eventIdFor('612999', '3900002'));
});

test('date helpers respect the calendar timezone and cross DST safely', () => {
  assert.equal(localDateString('2026-09-13T03:59:00.000Z', TZ), '2026-09-12', 'late-night EDT');
  assert.equal(addDays('2026-11-01', 1), '2026-11-02', 'DST fall-back weekend');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('a midnight deadline lands on the night it is actually due', () => {
  const midnight = a({ dueISO: '2026-09-20T04:00:00.000Z' }); // 2026-09-20 00:00 EDT
  assert.equal(dueDateFor(midnight, TZ, { shiftMidnight: true }), '2026-09-19');
  assert.equal(dueDateFor(midnight, TZ, { shiftMidnight: false }), '2026-09-20');
  assert.equal(dueDateFor(a(), TZ, SETTINGS), '2026-09-12', '23:59 is untouched');
});

test('buildEvent produces an all-day event with an exclusive end date', async () => {
  const { event, hash } = await buildEvent({ assignment: a(), course, timeZone: TZ, settings: SETTINGS });
  assert.equal(event.summary, 'CS 121 — Problem Set 2');
  assert.equal(event.start.date, '2026-09-12');
  assert.equal(event.end.date, '2026-09-13', 'Google treats end.date as exclusive');
  assert.equal(event.transparency, 'transparent', 'deadlines must not mark you busy');
  assert.deepEqual(event.reminders.overrides, [{ method: 'popup', minutes: 900 }]);
  assert.equal(event.extendedProperties.private.gsAssignmentId, '3900002');
  assert.match(event.description, /gradescope\.com\/courses\/612345\/assignments\/3900002/);
  assert.equal(typeof hash, 'string');
});

test('the content hash changes only when something visible changes', async () => {
  const base = await buildEvent({ assignment: a(), course, timeZone: TZ, settings: SETTINGS });
  const sameAgain = await buildEvent({ assignment: a(), course, timeZone: TZ, settings: SETTINGS });
  const renamed = await buildEvent({
    assignment: a({ name: 'Problem Set 2 (revised)' }),
    course,
    timeZone: TZ,
    settings: SETTINGS,
  });
  const moved = await buildEvent({
    assignment: a({ dueISO: '2026-09-15T03:59:00.000Z' }),
    course,
    timeZone: TZ,
    settings: SETTINGS,
  });
  assert.equal(base.hash, sameAgain.hash);
  assert.notEqual(base.hash, renamed.hash);
  assert.notEqual(base.hash, moved.hash);
  assert.equal(base.id, moved.id, 'moving a deadline updates the same event, never a duplicate');
});

test('selectAssignments applies the submitted and past filters', () => {
  const now = new Date('2026-09-12T18:00:00Z'); // 2pm EDT on the 12th
  const list = [
    a({ assignmentId: '1', dueISO: '2026-09-13T03:59:00.000Z' }), // today
    a({ assignmentId: '2', dueISO: '2026-09-20T03:59:00.000Z' }), // future
    a({ assignmentId: '3', dueISO: '2026-09-01T03:59:00.000Z' }), // past
    a({ assignmentId: '4', dueISO: '2026-09-20T03:59:00.000Z', submitted: true }),
  ];
  const kept = selectAssignments({ assignments: list, timeZone: TZ, settings: SETTINGS, now });
  assert.deepEqual(kept.map((x) => x.assignmentId), ['1', '2'], "today's deadline stays visible");

  const all = selectAssignments({
    assignments: list,
    timeZone: TZ,
    settings: { ...SETTINGS, skipSubmitted: false, skipPast: false },
    now,
  });
  assert.equal(all.length, 4);
});

test('diff writes changes, skips unchanged, and deletes vanished assignments', () => {
  const desired = [
    { id: 'gsaaa', hash: 'h1', courseId: '612345' },
    { id: 'gsbbb', hash: 'h2-new', courseId: '612345' },
  ];
  const synced = {
    gsaaa: { hash: 'h1', courseId: '612345' },
    gsbbb: { hash: 'h2-old', courseId: '612345' },
    gsccc: { hash: 'h3', courseId: '612345' }, // submitted since last run
  };
  const res = diff({ desired, synced, deletableCourseIds: ['612345'] });
  assert.deepEqual(res.unchanged, ['gsaaa']);
  assert.deepEqual(res.writes.map((w) => w.id), ['gsbbb']);
  assert.deepEqual(res.deletes.map((d) => d.id), ['gsccc']);
  assert.deepEqual(res.orphaned, []);
});

test('FAILURE GUARD: a course that did not parse cleanly never loses its events', () => {
  const synced = {
    gsaaa: { hash: 'h1', courseId: '612345' },
    gsbbb: { hash: 'h2', courseId: '612999' },
  };
  // 612999 failed to parse this run, so it is absent from deletableCourseIds
  const res = diff({ desired: [], synced, deletableCourseIds: ['612345'] });
  assert.deepEqual(res.deletes.map((d) => d.id), ['gsaaa']);
  assert.deepEqual(res.orphaned, ['gsbbb'], 'kept, not deleted');

  const total = diff({ desired: [], synced, deletableCourseIds: [] });
  assert.deepEqual(total.deletes, [], 'a fully failed scrape deletes nothing at all');
});

test('a second identical run is a no-op', async () => {
  const built = await buildEvent({ assignment: a(), course, timeZone: TZ, settings: SETTINGS });
  const synced = { [built.id]: { hash: built.hash, courseId: built.courseId } };
  const res = diff({ desired: [built], synced, deletableCourseIds: ['612345'] });
  assert.deepEqual(res.writes, []);
  assert.deepEqual(res.deletes, []);
  assert.deepEqual(res.unchanged, [built.id]);
});

test('reminder settings map to the three legal Google shapes', async () => {
  const shape = async (reminderMinutes) =>
    (await buildEvent({ assignment: a(), course, timeZone: TZ, settings: { ...SETTINGS, reminderMinutes } }))
      .event.reminders;
  assert.deepEqual(await shape(900), { useDefault: false, overrides: [{ method: 'popup', minutes: 900 }] });
  assert.deepEqual(await shape(null), { useDefault: true });
  assert.deepEqual(await shape(false), { useDefault: false, overrides: [] });
});
