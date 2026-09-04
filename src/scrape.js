/**
 * Injected into a real gradescope.com tab.
 *
 * This exists because an MV3 service worker cannot read Gradescope: its fetches originate
 * from the chrome-extension:// origin, which is cross-site, so Gradescope's SameSite=Lax
 * session cookie is never attached. Running here — same-origin with the page — the browser
 * sends the session the user is already logged into, and no credential is ever stored.
 *
 * Classic content script: no top-level await, no static imports.
 */
(async () => {
  if (window.__gradescopeSyncRunning) return;
  window.__gradescopeSyncRunning = true;

  const REQUEST_SPACING_MS = 800; // deliberately gentle: this runs once a day
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const send = (payload) => {
    window.__gradescopeSyncRunning = false;
    chrome.runtime.sendMessage({ type: 'GS_SCRAPE_RESULT', ...payload });
  };

  try {
    const { parseCourses, parseAssignments, isLoginPage } = await import(
      chrome.runtime.getURL('src/parse.js')
    );

    if (isLoginPage(document) || location.pathname.startsWith('/login')) {
      send({ ok: false, reason: 'not-logged-in' });
      return;
    }

    const { courses: savedCourses = [], settings = {} } = await chrome.storage.local.get([
      'courses',
      'settings',
    ]);
    const disabled = new Set(savedCourses.filter((c) => c.enabled === false).map((c) => c.id));

    // We are already sitting on /account, so parse the live DOM instead of refetching it.
    const accountHtml = document.documentElement.outerHTML;
    if (settings.debugDumpHtml) console.log('[gs-sync] /account html', accountHtml);

    const parsed = parseCourses(accountHtml);
    if (!parsed.ok) {
      send({ ok: false, reason: parsed.reason });
      return;
    }

    const studentCourses = parsed.courses.filter((c) => c.role === 'student');
    const toFetch = studentCourses.filter((c) => !disabled.has(c.id));
    const results = [];

    for (const [i, course] of toFetch.entries()) {
      if (i > 0) await sleep(REQUEST_SPACING_MS);
      try {
        const res = await fetch(course.url, {
          credentials: 'same-origin',
          headers: { Accept: 'text/html' },
        });

        if (res.redirected && /\/login/.test(res.url)) {
          send({ ok: false, reason: 'not-logged-in' });
          return;
        }
        if (!res.ok) {
          results.push({ courseId: course.id, ok: false, reason: `http-${res.status}`, assignments: [] });
          continue;
        }

        const html = await res.text();
        if (settings.debugDumpHtml) console.log(`[gs-sync] course ${course.id} html`, html);

        const out = parseAssignments(html, course.id);
        if (!out.ok && out.reason === 'not-logged-in') {
          send({ ok: false, reason: 'not-logged-in' });
          return;
        }
        results.push({
          courseId: course.id,
          ok: out.ok,
          reason: out.reason ?? null,
          assignments: out.assignments,
          warnings: out.warnings ?? [],
        });
      } catch (err) {
        results.push({
          courseId: course.id,
          ok: false,
          reason: `fetch-failed: ${err?.message ?? err}`,
          assignments: [],
        });
      }
    }

    send({
      ok: true,
      courses: studentCourses,
      skippedCourseIds: [...disabled],
      results,
      warnings: parsed.warnings,
    });
  } catch (err) {
    send({ ok: false, reason: `scrape-crashed: ${err?.message ?? err}` });
  }
})();
