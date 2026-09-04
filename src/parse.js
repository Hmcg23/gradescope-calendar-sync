/**
 * Pure Gradescope HTML parsing. No chrome.* APIs, no network — so this exact file runs
 * both inside the injected content script (via dynamic import) and under `node --test`.
 *
 * Everything returns { ok, ... , warnings } rather than throwing, because a *structural*
 * failure (Gradescope changed its markup) must suppress calendar deletions instead of
 * silently looking like "you have no assignments".
 */

export const GRADESCOPE_ORIGIN = 'https://www.gradescope.com';

/** @param {string} html */
export function toDocument(html) {
  const DP = globalThis.DOMParser;
  if (!DP) throw new Error('parse.js requires a DOMParser (browser, or linkedom in tests)');
  return new DP().parseFromString(html, 'text/html');
}

/**
 * Gradescope emits datetime attributes like "2026-09-10 23:59:00 -0400" — close to ISO
 * but not quite. Normalise before Date parsing so behaviour never depends on engine leniency.
 * @returns {string|null} ISO-8601 UTC string
 */
export function parseGsDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}):?(\d{2})$/);
  let date;
  if (m) {
    const time = m[2].length === 5 ? `${m[2]}:00` : m[2];
    date = new Date(`${m[1]}T${time}${m[3]}:${m[4]}`);
  } else {
    date = new Date(s);
  }
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** True when Gradescope bounced us to the sign-in page instead of the requested page. */
export function isLoginPage(doc) {
  return Boolean(
    doc.querySelector('form[action="/login"]') ||
      doc.querySelector('input[name="session[email]"]') ||
      doc.querySelector('.js-signInForm'),
  );
}

const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();

/**
 * Parse /account into the list of courses.
 * Walks headings and course boxes in document order so each course keeps the term and the
 * student/instructor section it appeared under.
 */
export function parseCourses(html) {
  const doc = toDocument(html);
  if (isLoginPage(doc)) return { ok: false, reason: 'not-logged-in', courses: [], warnings: [] };

  const warnings = [];
  const courses = [];
  let role = 'student';
  let term = null;

  const nodes = doc.querySelectorAll('h1, h2, h3, .courseList--term, a.courseBox');
  for (const node of nodes) {
    const isCourse = node.tagName === 'A' && node.classList.contains('courseBox');
    if (isCourse) {
      const href = node.getAttribute('href') || '';
      const m = href.match(/\/courses\/(\d+)/);
      if (!m) continue; // the "Add a course" box has no course href
      courses.push({
        id: m[1],
        shortName: squash(node.querySelector('.courseBox--shortname')?.textContent) || null,
        name: squash(node.querySelector('.courseBox--name')?.textContent) || null,
        term,
        role,
        url: `${GRADESCOPE_ORIGIN}/courses/${m[1]}`,
      });
      continue;
    }
    if (node.classList.contains('courseList--term')) {
      term = squash(node.textContent) || null;
      continue;
    }
    const text = squash(node.textContent);
    if (/instructor\s+courses/i.test(text)) role = 'instructor';
    else if (/student\s+courses/i.test(text)) role = 'student';
  }

  if (courses.length === 0) warnings.push('no-courses-found');
  return { ok: true, courses, warnings };
}

/**
 * Parse a course page into assignments.
 * @param {string} html
 * @param {string} courseId
 */
export function parseAssignments(html, courseId) {
  const doc = toDocument(html);
  if (isLoginPage(doc)) {
    return { ok: false, reason: 'not-logged-in', assignments: [], warnings: [] };
  }

  const table =
    doc.querySelector('#assignments-student-table') || doc.querySelector('table.js-assignmentTable');
  let rows = table
    ? [...table.querySelectorAll('tbody tr')]
    : [...doc.querySelectorAll('tr[role="row"]')].filter((r) => r.querySelector('th'));

  if (!table && rows.length === 0) {
    // No table AND no rows: either markup changed or this is an instructor-only course.
    // Either way we must not treat it as "zero assignments" and delete events.
    return { ok: false, reason: 'no-assignment-table', assignments: [], warnings: [] };
  }

  const warnings = [];
  const assignments = [];
  let undated = 0;

  for (const row of rows) {
    const th = row.querySelector('th');
    if (!th) continue;

    const name = squash(th.textContent);
    if (!name) continue;

    const link = th.querySelector('a[href*="/assignments/"]') || row.querySelector('a[href*="/assignments/"]');
    const button = th.querySelector('button[data-assignment-id]') || row.querySelector('button[data-assignment-id]');

    let assignmentId = null;
    if (link) assignmentId = (link.getAttribute('href') || '').match(/\/assignments\/(\d+)/)?.[1] ?? null;
    if (!assignmentId && button) assignmentId = button.getAttribute('data-assignment-id');
    if (!assignmentId) assignmentId = `name:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

    const dueEls = [...row.querySelectorAll('.submissionTimeChart--dueDate')];
    const dueISO = parseGsDate(dueEls[0]?.getAttribute('datetime'));
    const lateDueISO = parseGsDate(dueEls[1]?.getAttribute('datetime'));
    const releaseISO = parseGsDate(
      row.querySelector('.submissionTimeChart--releaseDate')?.getAttribute('datetime'),
    );

    if (!dueISO) {
      undated += 1;
      continue; // nothing to put on a calendar
    }

    const statusEl = row.querySelector('.submissionStatus');
    const statusText = squash(statusEl?.textContent);
    const hasScore = Boolean(row.querySelector('.submissionStatus--score'));
    const submitted = hasScore || (statusText !== '' && !/no submission/i.test(statusText));

    const href = link?.getAttribute('href');
    const url = href
      ? new URL(href, GRADESCOPE_ORIGIN).toString()
      : `${GRADESCOPE_ORIGIN}/courses/${courseId}/assignments/${assignmentId}`;

    assignments.push({
      courseId: String(courseId),
      assignmentId: String(assignmentId),
      name,
      url,
      dueISO,
      lateDueISO,
      releaseISO,
      submitted,
      statusText,
    });
  }

  if (undated > 0) warnings.push(`${undated}-assignments-without-due-date`);
  return { ok: true, assignments, warnings };
}
