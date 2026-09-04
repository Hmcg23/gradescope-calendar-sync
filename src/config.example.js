/**
 * Template. Copy to src/config.js and fill in — config.js is gitignored so the secret
 * never enters git history.
 *
 * Google OAuth credentials.
 *
 * These belong to a "Web application" OAuth client whose authorised redirect URI is
 * chrome.identity.getRedirectURL(), i.e. https://<extension-id>.chromiumapp.org/
 *
 * On the client secret: Google requires one when exchanging an authorization code for a web
 * client, and an extension has nowhere to hide it — anyone with the unpacked folder can read
 * it. That is a known and accepted property of public OAuth clients. It grants no access to
 * your data: a token still requires a user to sit through the consent screen. The realistic
 * abuse is someone impersonating this app's name on a consent screen of their own. PKCE is
 * still used, so an intercepted authorization code is useless without the matching verifier.
 *
 * If this extension were ever distributed, the secret would be rotated and the exchange moved
 * behind a small server. For a personal, locally-loaded extension it stays here.
 */

export const GOOGLE_CLIENT_ID = 'REPLACE_WITH_WEB_APPLICATION_CLIENT_ID.apps.googleusercontent.com';
export const GOOGLE_CLIENT_SECRET = 'REPLACE_WITH_WEB_APPLICATION_CLIENT_SECRET';

export const SCOPES = ['https://www.googleapis.com/auth/calendar.app.created'];
