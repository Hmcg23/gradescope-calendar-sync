/** Typed access to chrome.storage.local, with defaults in one place. */

export const DEFAULTS = {
  calendarId: null,
  calendarTimeZone: null,
  lastSyncAt: null,
  lastSyncStatus: 'never', // never | ok | error | login-required
  lastError: null,
  lastSummary: null, // { created, updated, deleted, unchanged, courses, assignments }
  courses: [], // [{ id, shortName, name, term, enabled }]
  synced: {}, // { [eventId]: { hash, courseId, assignmentId, dueISO } }
  settings: {
    skipSubmitted: true,
    skipPast: true,
    shiftMidnight: true,
    reminderMinutes: 900, // 9am the day before, for an all-day event
    calendarName: 'Gradescope',
    dryRun: false,
    debugDumpHtml: false,
  },
};

export async function getState() {
  const stored = await chrome.storage.local.get(null);
  return {
    ...DEFAULTS,
    ...stored,
    settings: { ...DEFAULTS.settings, ...(stored.settings ?? {}) },
  };
}

export async function setState(patch) {
  await chrome.storage.local.set(patch);
}

export async function updateSettings(patch) {
  const { settings } = await getState();
  const next = { ...settings, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** Merge freshly discovered courses, preserving the user's per-course enabled flag. */
export async function mergeCourses(discovered) {
  const { courses } = await getState();
  const previous = new Map(courses.map((c) => [c.id, c]));
  const merged = discovered.map((c) => ({ ...c, enabled: previous.get(c.id)?.enabled ?? true }));
  await chrome.storage.local.set({ courses: merged });
  return merged;
}

export async function resetSyncState() {
  await chrome.storage.local.set({ synced: {}, lastSummary: null, lastError: null });
}
