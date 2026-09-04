#!/usr/bin/env node
/**
 * Prints this extension's pinned ID, and generates the keypair the first time.
 *
 * Chrome derives an unpacked extension's ID from the public key in manifest.json ("key").
 * That ID is registered against the Google Cloud OAuth client, so it must never change —
 * regenerating the key silently breaks Google sign-in.
 *
 * The private key deliberately lives OUTSIDE this folder: Chrome scans a loaded extension
 * directory and warns about any .pem it finds there. It is only needed to pack a .crx.
 *
 *   node scripts/extension-id.mjs            # print the current ID
 *   node scripts/extension-id.mjs --write    # also patch manifest.json
 *   node scripts/extension-id.mjs --force    # mint a NEW key (changes the ID — breaks OAuth)
 *   GS_EXT_KEY=/path/to/key.pem node scripts/extension-id.mjs
 */
import { generateKeyPairSync, createPublicKey, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const KEY_PATH =
  process.env.GS_EXT_KEY || join(homedir(), 'Documents/gradescope-calendar-sync-key/extension.pem');

const force = process.argv.includes('--force');
const write = process.argv.includes('--write');

/** Chrome's ID = first 16 bytes of SHA-256(public key DER), hex, with 0-9a-f mapped to a-p. */
const idFromDer = (der) =>
  [...createHash('sha256').update(der).digest('hex').slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');

const manifest = readFileSync('manifest.json', 'utf8');
const existingKey = manifest.match(/"key":\s*"([^"]*)"/)?.[1];
const manifestHasKey = existingKey && !existingKey.startsWith('REPLACE');

let publicDer;
let source;

if (manifestHasKey && !force) {
  // The manifest is the source of truth for the ID. Never regenerate over a live key.
  publicDer = Buffer.from(existingKey, 'base64');
  source = 'manifest.json';
} else if (existsSync(KEY_PATH) && !force) {
  publicDer = createPublicKey(readFileSync(KEY_PATH, 'utf8')).export({ type: 'spki', format: 'der' });
  source = KEY_PATH;
} else {
  if (manifestHasKey && force) {
    console.log('!! --force: minting a new key. The extension ID will change and the existing');
    console.log('!! Google OAuth client will stop working until you register the new ID.\n');
  }
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  writeFileSync(KEY_PATH, privateKey, { mode: 0o600 });
  publicDer = publicKey;
  source = `${KEY_PATH} (new)`;
  console.log(`Wrote a new private key to ${KEY_PATH}\n`);
}

const manifestKey = Buffer.from(publicDer).toString('base64');

if (write && manifestKey !== existingKey) {
  writeFileSync('manifest.json', manifest.replace(/"key":\s*"[^"]*"/, `"key": "${manifestKey}"`));
  console.log('Patched manifest.json "key".\n');
} else if (!manifestHasKey) {
  console.log('Paste into manifest.json (or re-run with --write):\n');
  console.log(`  "key": "${manifestKey}",\n`);
}

console.log(`Extension ID (from ${source}):\n`);
console.log(`  ${idFromDer(publicDer)}\n`);
console.log('Use it as the Item ID of the Chrome Extension OAuth client in Google Cloud.');
