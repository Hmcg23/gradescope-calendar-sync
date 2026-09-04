# Gradescope → Calendar

A Chrome extension that mirrors your Gradescope assignment deadlines into a dedicated
**Gradescope** Google Calendar, once a day. Unsubmitted, not-yet-past assignments become all-day
events. No password is stored anywhere.

## How it works

An MV3 service worker cannot read Gradescope directly: its `fetch` calls come from the
`chrome-extension://` origin, which is cross-site, so Gradescope's `SameSite=Lax` session cookie is
never attached. So once a day the extension opens an inactive `gradescope.com/account` tab, injects
`src/scrape.js`, and does all reading **same-origin inside that tab** — riding the session you are
already logged into. The tab closes itself. The scraped assignments are diffed against what was
written last time and only the differences hit the Calendar API.

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

- Application type: **Chrome Extension**
- Item ID: the ID printed in step 1

Paste the resulting client ID into `manifest.json`:

```json
"oauth2": { "client_id": "…apps.googleusercontent.com", "scopes": ["https://www.googleapis.com/auth/calendar.app.created"] }
```

Then confirm nothing is missing:

```bash
npm run check
```

### 5. Load it

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
Confirm the ID shown matches step 1.

### 6. First sync

Click the toolbar icon → **Connect Google Calendar** → consent → **Sync now**.

A new **Gradescope** calendar appears in Google Calendar's sidebar, separate from your primary
calendar and independently toggleable.

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
npm test        # parsers + diff engine, 17 tests, no browser needed
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

- **Chrome only.** `chrome.identity.getAuthToken` is Chrome-specific; Firefox and Brave would need
  `launchWebAuthFlow` instead.
- Syncs when Chrome is running. A missed daily alarm fires on the next launch.
- `getAuthToken` uses the Google account signed into this Chrome profile.
- Unofficial scraping of your own pages, ~1 request/second, once a day. Gradescope could change
  its markup at any time.
