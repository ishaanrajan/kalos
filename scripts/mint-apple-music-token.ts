/// <reference types="node" />
/**
 * Mints an Apple Music API developer token -- a signed JWT that authorizes
 * catalog search + preview requests to api.music.apple.com. No Apple Music
 * subscription or Music-User-Token is needed for that; this token alone is
 * enough, which is why lib/music.ts can send it straight from the device the
 * same way it already sends nothing at all to the legacy iTunes endpoint.
 *
 * Run this by hand, not from the app or an Edge Function: the only secret
 * involved is the MusicKit private key (secrets/AuthKey_<KEY_ID>.p8, *.p8 is
 * git-ignored -- see .gitignore), and it never needs to leave this machine.
 * What comes out the other end -- the signed token -- carries no ability to
 * read or write anything beyond the public catalog, so it's fine to embed in
 * the client the same way EXPO_PUBLIC_GIPHY_API_KEY already is.
 *
 * Apple caps a token's validity at 6 months (15,777,000 seconds) from
 * signing. This one is cut to 150 days so there's always a few weeks of
 * slack before it actually expires. When it's due:
 *
 *   npx tsx scripts/mint-apple-music-token.ts
 *
 * -- paste the printed token over EXPO_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN in
 * .env, then `eas update` to both branches. It's a plain env var baked into
 * the JS bundle, so this never needs a native build.
 */
import { createSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Team ID: Apple Developer account, top right / Membership. Kalos's is
// already on record in AGENTS.md for the same account this key belongs to.
const TEAM_ID = 'C3AWB7CGFQ';
const KEY_ID = '5P8H7A8FPA';
const KEY_PATH = path.join(ROOT, 'secrets', `AuthKey_${KEY_ID}.p8`);
const VALIDITY_DAYS = 150;

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function main() {
  if (!fs.existsSync(KEY_PATH)) {
    console.error(`Private key not found at ${KEY_PATH}`);
    console.error('Download it from Certificates, Identifiers & Profiles -> Keys (only downloadable once)');
    console.error(`and save it there as secrets/AuthKey_${KEY_ID}.p8 (the folder is git-ignored).`);
    process.exit(1);
  }
  const privateKey = fs.readFileSync(KEY_PATH, 'utf8');

  const now = Math.floor(Date.now() / 1000);
  const exp = now + VALIDITY_DAYS * 24 * 60 * 60;

  const header = { alg: 'ES256', kid: KEY_ID };
  const payload = { iss: TEAM_ID, iat: now, exp };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  // JWS ES256 wants the raw 64-byte (r || s) signature, not the DER
  // structure crypto.sign() produces by default -- 'ieee-p1363' is exactly
  // that raw encoding, no manual ASN.1 unwrapping needed.
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });

  const token = `${signingInput}.${base64url(signature)}`;

  console.log('\nApple Music developer token (valid %s days, until %s):\n', VALIDITY_DAYS, new Date(exp * 1000).toISOString().slice(0, 10));
  console.log(token);
  console.log('\nPaste this as EXPO_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN in .env, then `eas update` both branches.\n');
}

main();
