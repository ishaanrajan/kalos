/**
 * Schema preflight -- run after applying migrations 0001-0006, before seeding.
 *
 *   npx tsx scripts/preflight.ts
 *
 * Mirrors the verification block in supabase/README.md, but over PostgREST
 * instead of the SQL editor, so it can run from a terminal. Checks that the
 * tables exist, the four RPCs exist with the signatures the client calls, both
 * storage buckets were created by migration 0005, and that RLS is actually
 * enforced -- an unauthenticated client must not be able to read profiles.
 */

/// <reference types="node" />

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const file of ['.env', '.env.local']) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) continue;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
}

const url = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !serviceKey || !anonKey) {
  console.error('Missing env. Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EXPO_PUBLIC_SUPABASE_ANON_KEY.');
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

let failed = 0;
function check(label: string, pass: boolean, detail = '') {
  if (!pass) failed++;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? `  -- ${detail}` : ''}`);
}

/** A missing function reads differently from a function that ran and errored. */
function isMissing(message: string | undefined) {
  return !!message && /does not exist|could not find the function/i.test(message);
}

async function main() {
  console.log(`\nPreflight against ${url}\n`);

  for (const t of ['profiles', 'posts', 'follows', 'likes', 'comments']) {
    const { error, count } = await admin.from(t).select('*', { count: 'exact', head: true });
    check(`table ${t}`, !error, error ? error.message : `${count} rows`);
  }

  // auth.uid() is null under the service role, so these return nothing. That is
  // fine -- this only asserts the function exists and accepts these arguments.
  for (const fn of ['home_feed', 'explore_feed']) {
    const { error } = await admin.rpc(fn, { before: null, before_id: null, lim: 1 });
    check(`rpc ${fn}(timestamptz, uuid, int)`, !isMissing(error?.message), error?.message ?? '');
  }
  // activity_feed is not keyset-paginated -- it takes only lim.
  {
    const { error } = await admin.rpc('activity_feed', { lim: 1 });
    check('rpc activity_feed(int)', !isMissing(error?.message), error?.message ?? '');
  }
  {
    const { error } = await admin.rpc('search_profiles', { q: 'a', lim: 1 });
    check('rpc search_profiles(text, int)', !isMissing(error?.message), error?.message ?? '');
  }

  const { data: buckets, error: bErr } = await admin.storage.listBuckets();
  const names = (buckets ?? []).map((b) => b.id).sort();
  check(
    'buckets photos + avatars',
    !bErr && ['avatars', 'photos'].every((n) => names.includes(n)),
    bErr ? bErr.message : `found [${names.join(', ')}]`,
  );

  // If RLS were off, PostgREST would hand rows to an unauthenticated caller.
  {
    const { data, error } = await anon.from('profiles').select('id').limit(1);
    const rows = data?.length ?? 0;
    check(
      'anon read blocked by RLS',
      !!error || rows === 0,
      error ? `denied (${error.code ?? 'error'})` : `returned ${rows} rows`,
    );
  }

  {
    const { count } = await admin.from('profiles').select('*', { count: 'exact', head: true });
    const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const n = users?.users.length ?? 0;
    check('one profile per auth user', (count ?? 0) === n, `${count} profiles / ${n} auth users`);
  }

  console.log(failed === 0 ? '\nAll preflight checks passed.\n' : `\n${failed} check(s) failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
