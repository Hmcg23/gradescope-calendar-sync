/**
 * Google Calendar client.
 *
 * Auth is chrome.identity.launchWebAuthFlow with authorization code + PKCE, NOT
 * getAuthToken. getAuthToken is Chrome-exclusive — it reads the Google account signed into
 * the Chrome profile — so it fails outright in Arc, Brave and other Chromium browsers.
 * launchWebAuthFlow is implemented everywhere, at the cost of us holding the refresh token.
 *
 * Scope is calendar.app.created only: this code can create calendars and fully manage the
 * ones it created, and can neither read nor touch the user's primary calendar.
 */
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SCOPES } from './config.js';

const API = 'https://www.googleapis.com/calendar/v3';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export class AuthError extends Error {}
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// ------------------------------------------------------------------ PKCE

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export function createCodeVerifier() {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

export async function codeChallengeFor(verifier) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

export function buildAuthUrl({ clientId, redirectUri, challenge, scopes = SCOPES }) {
  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline', // ask for a refresh token
    prompt: 'consent', // ...and make sure one is actually issued
  }).toString();
  return url.toString();
}

// ------------------------------------------------------------------ token storage

async function readAuth() {
  return (await chrome.storage.local.get('googleAuth')).googleAuth ?? null;
}

async function writeAuth(auth) {
  await chrome.storage.local.set({ googleAuth: auth });
}

async function clearAuth() {
  await chrome.storage.local.remove('googleAuth');
}

async function postForm(endpoint, params) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new AuthError(`${endpoint} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function storeTokens(payload, previousRefreshToken) {
  const auth = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    // a refresh response omits refresh_token; keep the one we already hold
    refreshToken: payload.refresh_token ?? previousRefreshToken ?? null,
  };
  await writeAuth(auth);
  return auth.accessToken;
}

// ------------------------------------------------------------------ flows

function launchWebAuthFlow(url) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirectUrl) => {
      const err = chrome.runtime.lastError;
      if (err || !redirectUrl) reject(new AuthError(err?.message || 'Sign-in was cancelled'));
      else resolve(redirectUrl);
    });
  });
}

async function interactiveSignIn() {
  const redirectUri = chrome.identity.getRedirectURL();
  const verifier = createCodeVerifier();
  const challenge = await codeChallengeFor(verifier);

  const redirectUrl = await launchWebAuthFlow(
    buildAuthUrl({ clientId: GOOGLE_CLIENT_ID, redirectUri, challenge }),
  );

  const params = new URL(redirectUrl).searchParams;
  const error = params.get('error');
  if (error) throw new AuthError(`Google returned "${error}"`);
  const code = params.get('code');
  if (!code) throw new AuthError('No authorization code in the redirect');

  const payload = await postForm(TOKEN_ENDPOINT, {
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  return storeTokens(payload);
}

async function refreshAccessToken(refreshToken) {
  try {
    const payload = await postForm(TOKEN_ENDPOINT, {
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    return await storeTokens(payload, refreshToken);
  } catch (e) {
    // invalid_grant = revoked by the user, or expired. Nothing to do but sign in again.
    if (/invalid_grant/.test(e.message)) await clearAuth();
    throw e;
  }
}

/**
 * Returns a usable access token, refreshing or prompting as needed.
 * With interactive:false this never shows UI — it is also the "are we connected?" probe.
 */
export async function getToken({ interactive = false } = {}) {
  const auth = await readAuth();

  if (auth?.accessToken && auth.expiresAt > Date.now() + 60000) return auth.accessToken;

  if (auth?.refreshToken) {
    try {
      return await refreshAccessToken(auth.refreshToken);
    } catch (e) {
      if (!interactive) throw new AuthError(`Could not refresh Google access: ${e.message}`);
    }
  }

  if (!interactive) throw new AuthError('Not connected to Google Calendar');
  return interactiveSignIn();
}

export async function revokeToken() {
  const auth = await readAuth();
  const token = auth?.refreshToken || auth?.accessToken;
  if (token) {
    try {
      await postForm(REVOKE_ENDPOINT, { token });
    } catch {
      /* already revoked or offline — clearing locally is what matters */
    }
  }
  await clearAuth();
}

/** Drop only the access token, so the next call refreshes it. */
async function invalidateAccessToken() {
  const auth = await readAuth();
  if (auth) await writeAuth({ ...auth, accessToken: null, expiresAt: 0 });
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
    await invalidateAccessToken();
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

  // Try to colour it and tick it visible in the sidebar. This normally fails: calendarList
  // is outside the calendar.app.created scope, and widening the scope to reach it would hand
  // us read/write on every calendar the user owns. So the calendar is created and written to,
  // but the user has to subscribe to it once by id — the options page shows them how.
  let listed = true;
  try {
    await call(`/users/me/calendarList/${encodeURIComponent(cal.id)}`, {
      method: 'PATCH',
      interactive,
      body: { colorId: '9', selected: true },
    });
  } catch (e) {
    listed = false;
    console.info(
      '[gs-sync] could not auto-show the calendar (expected with the narrow scope):',
      e.message,
    );
  }

  return { calendarId: cal.id, timeZone: cal.timeZone || timeZone, created: true, listed };
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
