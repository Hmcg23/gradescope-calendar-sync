#!/usr/bin/env node
/**
 * Generates (or reuses) the RSA keypair that pins this extension's ID.
 *
 * Chrome derives an unpacked extension's ID from the public key in manifest.json ("key").
 * Without a pinned key the ID changes per machine/install, which breaks the Google Cloud
 * OAuth client — it is registered against one specific extension ID.
 *
 * Private key goes to .keys/extension.pem (gitignored; only needed to pack a .crx later).
 * Pass --write to patch manifest.json in place.
 */
import { generateKeyPairSync, createPublicKey, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const KEY_DIR = '.keys';
const KEY_PATH = `${KEY_DIR}/extension.pem`;

let publicDer;
if (existsSync(KEY_PATH)) {
  console.log(`Reusing existing key at ${KEY_PATH}\n`);
  publicDer = createPublicKey(readFileSync(KEY_PATH, 'utf8')).export({ type: 'spki', format: 'der' });
} else {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  mkdirSync(KEY_DIR, { recursive: true });
  writeFileSync(KEY_PATH, privateKey, { mode: 0o600 });
  publicDer = publicKey;
  console.log(`Wrote new private key to ${KEY_PATH} (gitignored — back it up if you care)\n`);
}

const manifestKey = Buffer.from(publicDer).toString('base64');

// Chrome's ID = first 16 bytes of SHA-256(public key DER), hex, with 0-9a-f mapped to a-p.
const digest = createHash('sha256').update(publicDer).digest('hex').slice(0, 32);
const extensionId = [...digest].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

if (process.argv.includes('--write')) {
  const manifest = readFileSync('manifest.json', 'utf8');
  const patched = manifest.replace(/"key":\s*"[^"]*"/, `"key": "${manifestKey}"`);
  writeFileSync('manifest.json', patched);
  console.log('Patched manifest.json "key".\n');
} else {
  console.log('Paste into manifest.json (or re-run with --write):\n');
  console.log(`  "key": "${manifestKey}",\n`);
}

console.log('Item ID for the Google Cloud "Chrome Extension" OAuth client:\n');
console.log(`  ${extensionId}\n`);
console.log(`Origin: chrome-extension://${extensionId}/`);
