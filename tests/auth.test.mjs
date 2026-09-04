/** PKCE and the authorization URL — the parts of the Arc-compatible flow that are pure. */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let buildAuthUrl, codeChallengeFor, createCodeVerifier;

before(async () => {
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } } };
  ({ buildAuthUrl, codeChallengeFor, createCodeVerifier } = await import('../src/gcal.js'));
});

test('code challenge matches the RFC 7636 reference vector', async () => {
  // https://datatracker.ietf.org/doc/html/rfc7636#appendix-B
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(await codeChallengeFor(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('verifiers are unguessable, unique and URL-safe', () => {
  const a = createCodeVerifier();
  const b = createCodeVerifier();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43,128}$/, 'RFC 7636 allows 43-128 unreserved characters');
});

test('the auth URL asks for a refresh token and pins PKCE to S256', () => {
  const url = new URL(
    buildAuthUrl({
      clientId: 'client-123',
      redirectUri: 'https://abc.chromiumapp.org/',
      challenge: 'CHALLENGE',
      scopes: ['https://www.googleapis.com/auth/calendar.app.created'],
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = url.searchParams;
  assert.equal(p.get('response_type'), 'code', 'authorization code, not the deprecated implicit flow');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('code_challenge'), 'CHALLENGE');
  assert.equal(p.get('redirect_uri'), 'https://abc.chromiumapp.org/');
  assert.equal(p.get('access_type'), 'offline', 'without this Google issues no refresh token');
  assert.equal(p.get('prompt'), 'consent', 'and without this it may skip issuing a new one');
  assert.equal(p.get('scope'), 'https://www.googleapis.com/auth/calendar.app.created');
});
