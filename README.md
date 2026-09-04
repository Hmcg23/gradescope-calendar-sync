# Gradescope → Calendar

A browser extension that mirrors your Gradescope assignment deadlines into a dedicated
**Gradescope** Google Calendar, once a day. Unsubmitted, not-yet-past assignments become all-day
events. No password is stored anywhere.

Built and verified on **Arc**; the same build works in Chrome, Brave and Edge.

Gradescope has no public API, no ICS export and no calendar integration, so this scrapes your own
pages using the browser session you are already signed into. Setup needs a free Google Cloud project
of your own (steps below, ~10 minutes); there is no shared backend and no account to sign up for.

## How it works

An MV3 service worker cannot read Gradescope directly: its `fetch` calls come from the
`chrome-extension://` origin, which is cross-site, so Gradescope's `SameSite=Lax` session cookie is
never attached. So once a day the extension opens an inactive `gradescope.com/account` tab, injects
`src/scrape.js`, and does all reading **same-origin inside that tab** — riding the session you are
already logged into. The tab closes itself. The scraped assignments are diffed against what was
written last time and only the differences hit the Calendar API.

Google auth is `chrome.identity.launchWebAuthFlow` with authorization code + PKCE, and the refresh
token is kept in extension storage. The simpler `getAuthToken` was the original design, but it reads
the Google account from the Chrome profile and therefore fails outright in Arc and Brave.

Two design rules are load-bearing:

- **Deterministic event ids** (`gs` + truncated SHA-256 of `courseId:assignmentId`) mean a retry can
  never create a duplicate, and a moved deadline updates the existing event.
- **Deletions are scoped to courses that parsed cleanly this run.** If Gradescope changes its markup,
  or you are logged out, or a course page 500s, the extension refuses to interpret that as "you have
  no assignments" and leaves your events alone.

## Setup

You need a free Google Cloud project. Steps 2–4 are one-time.

### 1. Pin the extension ID

```bash
npm install
npm run id -- --write
```

This patches `manifest.json` and prints a 32-character **Item ID** — keep it for step 4. Without a
pinned key, an unpacked extension's ID changes between machines and Google sign-in breaks.

The private key is written to `~/Documents/gradescope-calendar-sync-key/extension.pem`, deliberately
**outside this folder**: Chrome scans a loaded extension directory and warns about any `.pem` it
finds inside one. Override the location with `GS_EXT_KEY=/path/to/key.pem`. The key is only needed
if you later pack a `.crx`; the unpacked extension runs from the public `"key"` in the manifest.

Re-running the command is safe — once `manifest.json` has a key it just reports the ID. Only
`--force` mints a new one, which changes the extension ID and breaks the OAuth client.

### 2. Enable the Calendar API

console.cloud.google.com → create a project → **APIs & Services → Library** → search
"Google Calendar API" → **Enable**.

### 3. Add the scope, then PUBLISH

Google replaced the old single "OAuth consent screen" page with **Google Auth Platform**, and split
these settings across its left-nav items. Older tutorials will not match what you see.

**Google Auth Platform → Data Access**

- **Add or remove scopes**
- `calendar.app.created` is not in the suggested list — paste it into the **"Manually add scopes"**
  box at the bottom, then **Add to table**:
  `https://www.googleapis.com/auth/calendar.app.created`
- **Update** → **Save**

**Google Auth Platform → Audience**

- User type: **External**
- Publishing status: click **Publish app** so it reads **In production**

That publish step matters. While the app sits in *Testing*, Google expires its refresh tokens after
seven days and the sync silently dies every week. Published-but-unverified is fine for personal use;
you will see an "unverified app" screen at sign-in — click **Advanced → Continue**.

### 4. Create the OAuth client

**Google Auth Platform → Clients → Create client**

- Application type: **Web application**
- Authorised redirect URI: `https://<extension-id>.chromiumapp.org/` — using the ID from step 1

Not "Chrome Extension": that type only works with `chrome.identity.getAuthToken`, which is
Chrome-exclusive and fails in Arc, Brave and Edge. This extension uses `launchWebAuthFlow`, which
needs a web client and the `chromiumapp.org` redirect.

Copy the template, then paste both values into it:

```bash
cp src/config.example.js src/config.js
```

```js
export const GOOGLE_CLIENT_ID = '…apps.googleusercontent.com';
export const GOOGLE_CLIENT_SECRET = 'GOCSPX-…';
```

`src/config.js` is gitignored, so the secret stays out of git history even if this repo is ever made
public. It does still ship inside the loaded extension — see the comment at the top of the file for
why that is acceptable for a public OAuth client, and what it does and does not expose.

Then confirm nothing is missing:

```bash
npm run check
```

### 5. Load it

In your browser (Chrome, Arc, Brave or Edge) go to `chrome://extensions` → turn on **Developer
mode** (top right) → **Load unpacked**.

In the file picker, select the **folder itself**, not a file inside it. In macOS's picker the
fastest route is ⌘⇧G, paste the folder path, Enter, then **Select**. If you get "Manifest file is
missing or unreadable", you picked the wrong level — the folder you choose must be the one
containing `manifest.json`.

Confirm the ID on the extension's tile matches step 1. If it differs, the manifest `key` is missing
and the OAuth client will reject you.

Pin it: puzzle-piece icon in the toolbar → pin **Gradescope → Calendar**.

**After any change to `manifest.json` or `src/config.js`, click the reload arrow on that tile.**
The browser caches both, so edits do nothing until you reload — this is the single most common
reason a fix appears not to work.

### 6. First sync

Click the toolbar icon → **Connect Google Calendar**. Pick your account → "Google hasn't verified
this app" → **Advanced** → **Continue** → the consent screen should read *"See, create, and change
events on Google calendars you create with this app"* → **Allow**.

That wording is worth reading: it confirms the narrow scope, and that the extension cannot see your
existing calendars.

Then do a dry run before letting it write anything: Options → tick **Dry run** → **Sync now** →
open the service worker console (`chrome://extensions` → your tile → the blue **service worker**
link → **Console**) and read the `[gs-sync] DRY RUN` block. Check the course count and assignment
names. Untick **Dry run**, **Sync now** again.

You will see a Gradescope tab flash open and close on each sync. That is the scrape.

This creates a **Gradescope** calendar and writes your deadlines into it.

**You then have to subscribe to it once.** The `calendar.app.created` scope lets the extension
create and fill its own calendar, but not touch your calendar list, so it cannot tick itself
visible — and widening the scope far enough to do that would grant read/write on every calendar you
own. Not a trade worth making for one click.

Open the extension's Options page, copy the calendar ID shown under **Calendar**, then in Google
Calendar: **Other calendars → + → Subscribe to calendar** → paste the ID. It stays visible from then
on, separate from your primary calendar and independently toggleable.

## Troubleshooting

Every one of these was hit while getting this running, so they are worth listing verbatim.

**"This extension includes the key file '…/extension.pem'. You probably don't want to do that."**
The signing key is inside the loaded folder. It belongs outside — see step 1. Warning only; the
extension still runs.

**"Access blocked: … request is invalid" / `Error 400: invalid_request`**
The OAuth client is the wrong type. A **Desktop app** client cannot be used this way; Google
disallowed custom URI schemes for them in October 2023. Create a **Web application** client (step 4).

**Sign-in does nothing at all, popup stays on "Not connected"**
You are on a Chromium browser that is not Chrome, and something is still calling
`chrome.identity.getAuthToken` — which only exists in Chrome, because it reads the account from the
Chrome profile. This project uses `launchWebAuthFlow` precisely to avoid that.

**`redirect_uri_mismatch`**
The URI registered on the client must match `chrome.identity.getRedirectURL()` exactly, including
the trailing slash: `https://<extension-id>.chromiumapp.org/`

**`invalid_client`**
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `src/config.js` do not match the client, or the
extension was not reloaded after editing them.

**"Sync failed" immediately after installing**
The daily alarm fires a minute after install, before you have connected Google. Expected. It clears
on the first successful sync.

**Popup says synced, but there is no calendar in Google Calendar**
Almost certainly the missing subscribe step — see step 6. To confirm the events really exist, paste
this into the service worker console:

```js
(async () => {
  const { googleAuth, calendarId } = await chrome.storage.local.get(['googleAuth','calendarId']);
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    { headers: { Authorization: `Bearer ${googleAuth.accessToken}` } });
  console.log((await r.json()).items?.map(e => `${e.start?.date}  ${e.summary}`));
})()
```

If that lists your assignments, the sync is fine and only the subscription is missing. (A 401 means
the access token expired — click **Sync now**, then re-run.) Note that a `calendarList` request will
always fail here: it is outside the scope, by design.

**Fewer deadlines than expected**
Submitted and past-due assignments are filtered out by default. Turn both filters off in Options to
see everything, or check per-course toggles.

## Settings

Right-click the icon → Options.

| Setting | Default |
|---|---|
| Hide submitted assignments | on |
| Hide past deadlines | on (today's always stay) |
| Midnight deadline shows the night before | on |
| Reminder | 9am the day before |
| Per-course on/off | all on, discovered automatically |
| Dry run | off |

## Development

```bash
npm test        # parsers, PKCE, diff engine, end-to-end sync — 29 tests, no browser needed
npm run check   # manifest validation + tests
```

`src/parse.js` and `src/sync.js` are pure — they run identically in the content script and under
`node --test`. Everything that touches `chrome.*` lives in `background.js`, `gcal.js`, `storage.js`
and the UI files.

### If Gradescope changes its HTML

You will see a "course page could not be read" warning rather than deleted events. To fix:

1. Options → enable **Dump scraped HTML to the console**.
2. Sync, open the Gradescope tab's console, copy the HTML.
3. Save it over `tests/fixtures/course-student.html`, run `npm test`, adjust selectors in
   `src/parse.js` until green.

## Limitations

- **Chromium browsers only** — Chrome, Arc, Brave, Edge. Firefox implements `launchWebAuthFlow`
  too but not MV3 service workers the same way, so it is untested there.
- Syncs when the browser is running. A missed daily alarm fires on the next launch.
- The refresh token is stored in `chrome.storage.local`, unencrypted like all extension storage.
- Unofficial scraping of your own pages, ~1 request/second, once a day. Gradescope could change
  its markup at any time.
- Not affiliated with or endorsed by Gradescope or Google.

## Contributing

Issues and PRs welcome. `npm run check` must pass. Parser changes should come with a fixture in
`tests/fixtures/` captured from a real course page — my own fixtures are synthetic, so real-world
markup from other schools is the most useful thing anyone can contribute.

## License

MIT — see [LICENSE](LICENSE).
