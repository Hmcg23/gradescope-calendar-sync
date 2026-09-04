import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

let parseCourses, parseAssignments, parseGsDate, isLoginPage, toDocument;

before(async () => {
  const { DOMParser } = await import('linkedom');
  globalThis.DOMParser = DOMParser;
  ({ parseCourses, parseAssignments, parseGsDate, isLoginPage, toDocument } = await import(
    '../src/parse.js'
  ));
});

test('parseGsDate normalises Gradescope datetime attributes', () => {
  assert.equal(parseGsDate('2026-09-12 23:59:00 -0400'), '2026-09-13T03:59:00.000Z');
  assert.equal(parseGsDate('2026-09-12T23:59:00-04:00'), '2026-09-13T03:59:00.000Z');
  assert.equal(parseGsDate('2026-09-12 23:59 -0400'), '2026-09-13T03:59:00.000Z');
  assert.equal(parseGsDate('2026-12-01 09:00:00 +0000'), '2026-12-01T09:00:00.000Z');
  assert.equal(parseGsDate(''), null);
  assert.equal(parseGsDate(null), null);
  assert.equal(parseGsDate('sometime next week'), null);
});

test('isLoginPage detects the sign-in bounce', () => {
  assert.equal(isLoginPage(toDocument(fixture('login.html'))), true);
  assert.equal(isLoginPage(toDocument(fixture('account.html'))), false);
});

test('parseCourses separates student courses, terms and the add-course box', () => {
  const res = parseCourses(fixture('account.html'));
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, []);

  const student = res.courses.filter((c) => c.role === 'student');
  const instructor = res.courses.filter((c) => c.role === 'instructor');
  assert.equal(student.length, 3);
  assert.equal(instructor.length, 1);
  assert.equal(instructor[0].id, '999001');

  const cs121 = student.find((c) => c.id === '612345');
  assert.equal(cs121.shortName, 'CS 121');
  assert.equal(cs121.name, 'Introduction to Theoretical Computer Science');
  assert.equal(cs121.term, 'Fall 2026');
  assert.equal(cs121.url, 'https://www.gradescope.com/courses/612345');

  assert.equal(student.find((c) => c.id === '500111').term, 'Spring 2026');
  // the "Add a Course" button must never become a course
  assert.equal(res.courses.some((c) => /add a course/i.test(c.shortName ?? '')), false);
});

test('parseCourses reports a login bounce instead of an empty list', () => {
  const res = parseCourses(fixture('login.html'));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-logged-in');
  assert.deepEqual(res.courses, []);
});

test('parseAssignments reads ids, dates and submission status', () => {
  const res = parseAssignments(fixture('course-student.html'), '612345');
  assert.equal(res.ok, true);
  assert.equal(res.assignments.length, 4, 'the undated row is dropped');
  assert.deepEqual(res.warnings, ['1-assignments-without-due-date']);

  const byName = Object.fromEntries(res.assignments.map((a) => [a.name, a]));

  const ps1 = byName['Problem Set 1'];
  assert.equal(ps1.assignmentId, '3900001');
  assert.equal(ps1.submitted, true, 'a score means submitted');
  assert.equal(ps1.dueISO, '2026-09-02T03:59:00.000Z');
  assert.equal(ps1.url, 'https://www.gradescope.com/courses/612345/assignments/3900001/submissions/77000');

  const ps2 = byName['Problem Set 2'];
  assert.equal(ps2.assignmentId, '3900002', 'id falls back to data-assignment-id');
  assert.equal(ps2.submitted, false);
  assert.equal(ps2.dueISO, '2026-09-13T03:59:00.000Z');
  assert.equal(ps2.lateDueISO, '2026-09-15T03:59:00.000Z', 'second dueDate span is the late deadline');
  assert.equal(ps2.url, 'https://www.gradescope.com/courses/612345/assignments/3900002');

  assert.equal(byName['Lab 3'].submitted, true, '"Submitted" without a score still counts');
  assert.equal(byName['Midnight Quiz'].lateDueISO, null);
  assert.equal(res.assignments.every((a) => a.courseId === '612345'), true);
});

test('an empty table is a real empty course, a missing table is a structural failure', () => {
  const empty = parseAssignments(fixture('course-empty.html'), '1');
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.assignments, []);

  const broken = parseAssignments(fixture('course-no-table.html'), '1');
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, 'no-assignment-table');
});

test('parseAssignments reports a login bounce', () => {
  const res = parseAssignments(fixture('login.html'), '1');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-logged-in');
});
