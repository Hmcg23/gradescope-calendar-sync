/**
 * Pure sync logic: turn scraped assignments into calendar events, then diff them against
 * what we wrote last time. No chrome.* APIs and no network, so it is unit-testable.
 *
 * Two invariants matter more than anything else here:
 *   1. Event ids are deterministic, so a retry can never create a duplicate.
 *   2. Deletions only ever happen for courses that parsed cleanly this run.
 */

const enc = new TextEncoder();

export async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Google event ids must match [a-v0-9]{5,1024}. Hex is a subset, so a truncated SHA-256
 * is a legal id — which lets us upsert without keeping a server-side id map.
 */
export async function eventIdFor(courseId, assignmentId) {
  return 'gs' + (await sha256Hex(`${courseId}:${assignmentId}`)).slice(0, 32);
}

/** YYYY-MM-DD for an instant, as seen in a given IANA timezone. */
export function localDateString(iso, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** HH:MM for an instant, as seen in a given IANA timezone. */
export function localTimeString(iso, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** Calendar-date arithmetic on YYYY-MM-DD strings, DST-proof because it never leaves UTC. */
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function prettyDueTime(iso, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/**
 * Which calendar day an assignment belongs on.
 * A deadline at exactly 00:00 means "end of the previous night" in every course I have seen,
 * so by default it lands on the day before rather than orphaning itself on a fresh morning.
 */
export function dueDateFor(assignment, timeZone, { shiftMidnight = true } = {}) {
  const date = localDateString(assignment.dueISO, timeZone);
  if (shiftMidnight && localTimeString(assignment.dueISO, timeZone) === '00:00') {
    return addDays(date, -1);
  }
  return date;
}

export async function buildEvent({ assignment, course, timeZone, settings }) {
  const id = await eventIdFor(assignment.courseId, assignment.assignmentId);
  const date = dueDateFor(assignment, timeZone, settings);
  const label = course?.shortName || course?.name || `Course ${assignment.courseId}`;

  const lines = [`Due ${prettyDueTime(assignment.dueISO, timeZone)}`];
  if (assignment.lateDueISO) {
    lines.push(`Late deadline ${prettyDueTime(assignment.lateDueISO, timeZone)}`);
  }
  if (course?.name && course.name !== label) lines.push(course.name);
  lines.push('', assignment.url, '', 'Synced from Gradescope. Edits here are overwritten.');

  const event = {
    id,
    summary: `${label} — ${assignment.name}`,
    description: lines.join('\n'),
    start: { date },
    end: { date: addDays(date, 1) },
    transparency: 'transparent',
    source: { title: 'Gradescope', url: assignment.url },
    extendedProperties: {
      private: {
        gsCourseId: String(assignment.courseId),
        gsAssignmentId: String(assignment.assignmentId),
      },
    },
    reminders:
      settings.reminderMinutes === false
        ? { useDefault: false, overrides: [] } // explicitly: no reminder
        : settings.reminderMinutes === null || settings.reminderMinutes === undefined
          ? { useDefault: true }
          : { useDefault: false, overrides: [{ method: 'popup', minutes: settings.reminderMinutes }] },
  };

  const hash = await sha256Hex(
    JSON.stringify([event.summary, event.description, event.start.date, event.reminders]),
  );
  return { id, event, hash, courseId: String(assignment.courseId), dueISO: assignment.dueISO };
}

/** Apply the user's filters. `now` is injectable so tests are not time-dependent. */
export function selectAssignments({ assignments, timeZone, settings, now = new Date() }) {
  const today = localDateString(now.toISOString(), timeZone);
  return assignments.filter((a) => {
    if (settings.skipSubmitted && a.submitted) return false;
    if (settings.skipPast && dueDateFor(a, timeZone, settings) < today) return false;
    return true;
  });
}

/**
 * @param desired  array of buildEvent() results
 * @param synced   { [eventId]: { hash, courseId } } written by the previous run
 * @param deletableCourseIds  courses that parsed cleanly THIS run. Anything else is
 *                            untouched, so a scrape failure can never wipe the calendar.
 */
export function diff({ desired, synced, deletableCourseIds }) {
  const deletable = new Set(deletableCourseIds);
  const desiredById = new Map(desired.map((d) => [d.id, d]));

  const writes = [];
  const unchanged = [];
  for (const d of desired) {
    if (synced[d.id]?.hash === d.hash) unchanged.push(d.id);
    else writes.push(d);
  }

  const deletes = Object.entries(synced)
    .filter(([id, meta]) => !desiredById.has(id) && deletable.has(String(meta.courseId)))
    .map(([id, meta]) => ({ id, courseId: String(meta.courseId) }));

  const orphaned = Object.entries(synced)
    .filter(([id, meta]) => !desiredById.has(id) && !deletable.has(String(meta.courseId)))
    .map(([id]) => id);

  return { writes, deletes, unchanged, orphaned };
}
