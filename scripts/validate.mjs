#!/usr/bin/env node
/** Catches the manifest mistakes Chrome only reports at load time. */
import { readFileSync, existsSync } from 'node:fs';

const m = JSON.parse(readFileSync('manifest.json', 'utf8'));
const problems = [];
const blocking = [];

const files = [
  m.background?.service_worker,
  m.action?.default_popup,
  m.options_page,
  ...Object.values(m.icons ?? {}),
  ...Object.values(m.action?.default_icon ?? {}),
  ...(m.web_accessible_resources ?? []).flatMap((w) => w.resources),
  'src/scrape.js',
].filter(Boolean);

for (const f of new Set(files)) {
  const path = f.startsWith('src/') || f.startsWith('icons/') ? f : `src/${f}`;
  if (!existsSync(path) && !existsSync(f)) blocking.push(`missing file referenced by manifest: ${f}`);
}

if (String(m.key).startsWith('REPLACE')) blocking.push('manifest "key" not generated — run: npm run id -- --write');
if (String(m.oauth2?.client_id).startsWith('REPLACE')) problems.push('oauth2.client_id is still a placeholder — Google sign-in will fail until you set it (README step 4)');
if (!m.permissions?.includes('identity')) blocking.push('the "identity" permission is required by oauth2');
if (!m.host_permissions?.some((h) => h.includes('gradescope.com'))) blocking.push('missing gradescope.com host permission');
if (!(m.web_accessible_resources ?? []).some((w) => w.resources.includes('src/parse.js'))) blocking.push('src/parse.js must be web-accessible; the content script imports it');

for (const p of problems) console.log(`⚠︎  ${p}`);
for (const b of blocking) console.log(`✗  ${b}`);
if (!blocking.length) console.log(`✓  manifest ok — ${new Set(files).size} referenced files present`);
process.exit(blocking.length ? 1 : 0);
