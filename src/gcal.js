/**
 * Google Calendar client.
 *
 * Auth is chrome.identity.getAuthToken, which leans on the Google account already signed
 * into this Chrome profile. Chrome refreshes the token itself, so there is no refresh token
 * for us to store — and none to silently expire after seven days.
 *
 * Scope is calendar.app.created only: this code can create calendars and fully manage the
 * ones it created, and can neither read nor touch the user's primary calendar.
 */

const API = 'https://www.googleapis.com/calendar/v3';

export class AuthError extends Error {}
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function getToken({ interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err || !token) reject(new AuthError(err?.message || 'No Google token'));
      else resolve(token);
    });
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

export async function revokeToken() {
  try {
    const token = await getToken({ interactive: false });
    await removeCachedToken(token);
    await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
  } catch {
    /* nothing cached to revoke */
  }
  await new Promise((resolve) => chrome.identity.clearAllCachedAuthTokens(resolve));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One API call with: a single silent re-auth on 401, and exponential backoff with jitter
 * on rate limits and 5xx.
 */
async function call(path, { method = 'GET', body, interactive = false, attempt = 0 } = {}) {
  const token = await getToken({ interactive });
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.ok) return res.status === 204 ? null : res.json();

  const text = await res.text();

  if (res.status === 401 && attempt === 0) {
    await removeCachedToken(token);
    return call(path, { method, body, interactive, attempt: 1 });
  }

  const retryable = res.status === 429 || res.status >= 500 || /rateLimitExceeded|userRateLimitExceeded/.test(text);
  if (retryable && attempt < 5) {
    await sleep(Math.min(2 ** attempt * 500, 16000) + Math.random() * 400);
    return call(path, { method, body, interactive, attempt: attempt + 1 });
  }

  throw new ApiError(`Calendar API ${method} ${path} → ${res.status}`, res.status, text);
}

export async function ensureCalendar({ calendarId, name, timeZone, interactive = false }) {
  if (calendarId) {
    try {
      const cal = await call(`/calendars/${encodeURIComponent(calendarId)}`, { interactive });
      return { calendarId: cal.id, timeZone: cal.timeZone || timeZone, created: false };
    } catch (e) {
      if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 403)) throw e;
      // fall through and make a new one — the user deleted it
    }
  }

  const cal = await call('/calendars', {
    method: 'POST',
    interactive,
    body: { summary: name, description: 'Assignment deadlines synced from Gradescope.', timeZone },
  });

  // Colour it so it is visually distinct in the sidebar. Non-fatal if it fails.
  try {
    await call(`/users/me/calendarList/${encodeURIComponent(cal.id)}`, {
      method: 'PATCH',
      interactive,
      body: { colorId: '9', selected: true },
    });
  } catch {
    /* cosmetic only */
  }

  return { calendarId: cal.id, timeZone: cal.timeZone || timeZone, created: true };
}

/** Upsert by deterministic id: update first (the common case), insert if it is not there yet. */
export async function upsertEvent(calendarId, event) {
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
  try {
    await call(`${base}/${event.id}`, { method: 'PUT', body: event });
    return 'updated';
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
      try {
        await call(base, { method: 'POST', body: event });
        return 'created';
      } catch (e2) {
        // 409 means a previous attempt already inserted it; treat the write as done.
        if (e2 instanceof ApiError && e2.status === 409) return 'updated';
        throw e2;
      }
    }
    throw e;
  }
}

export async function deleteEvent(calendarId, eventId) {
  try {
    await call(`/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, { method: 'DELETE' });
  } catch (e) {
    // Already gone (user deleted it by hand) is success as far as we are concerned.
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 410)) throw e;
  }
}
