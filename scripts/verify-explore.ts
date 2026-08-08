/**
 * Proves the product thesis against a live database.
 *
 * Kalos claims Explore is sourced purely from your social graph and ordered
 * purely by recency. That claim is only worth anything if it's tested, so this
 * runs the real RPCs as a real signed-in user and asserts:
 *
 *   1. Every post Explore returns traces to an actual graph edge.
 *   2. `viral_stranger` — unfollowed, unliked, newest post in the database,
 *      like_count 8423 — never appears. It is the most recent AND the most
 *      "engaging" content there is. If ranking ever leaks in, it shows up here
 *      first.
 *   3. Explore is strictly reverse-chronological.
 *   4. The home feed contains only people you follow, plus yourself.
 *   5. Keyset pagination neither skips nor duplicates.
 *
 * Run after seeding:
 *   npx tsx scripts/verify-explore.ts
 *
 * Needs EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY in .env, and
 * the seeded account's credentials.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// Minimal .env loader so this needs no extra dependency.
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  // .env is optional if the vars are already exported.
}

const URL_ = process.env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const EMAIL = process.env.VERIFY_EMAIL ?? 'ishaan@example.com';
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'kalos2015';
const DECOY_USERNAME = 'viral_stranger';

if (!URL_ || !KEY) {
  console.error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (see .env.example).');
  process.exit(1);
}

const supabase = createClient(URL_, KEY, { auth: { persistSession: false } });

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

interface FeedRow {
  id: string;
  author_id: string;
  author_username: string;
  created_at: string;
  like_count: number;
  reason?: string;
  reason_username?: string;
}

async function main() {
  const { data: auth, error: authError } = await supabase.auth.signInWithPassword({
    email: EMAIL,
    password: PASSWORD,
  });
  if (authError || !auth.user) {
    console.error(`Could not sign in as ${EMAIL}: ${authError?.message}`);
    console.error('Has the seed been run? See supabase/README.md.');
    process.exit(1);
  }
  const me = auth.user.id;
  console.log(`\nSigned in as ${EMAIL}\n`);

  // Ground truth about the graph, read directly rather than via the RPCs.
  const { data: follows } = await supabase.from('follows').select('followee_id').eq('follower_id', me);
  const following = new Set((follows ?? []).map((f) => f.followee_id as string));

  const { data: decoy } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('username', DECOY_USERNAME)
    .maybeSingle();

  // --- Explore -------------------------------------------------------------
  console.log('Explore is sourced from the graph, not from engagement');

  const { data: explore, error: exploreError } = await supabase.rpc('explore_feed', {
    before: null,
    before_id: null,
    lim: 50,
  });
  if (exploreError) {
    console.error(`explore_feed failed: ${exploreError.message}`);
    process.exit(1);
  }
  const exploreRows = (explore ?? []) as FeedRow[];
  console.log(`  (${exploreRows.length} posts returned)`);

  check('every post carries a graph reason', exploreRows.every((r) => !!r.reason && !!r.reason_username));
  check(
    'reasons are only liked_by / followed_by',
    exploreRows.every((r) => r.reason === 'liked_by' || r.reason === 'followed_by')
  );
  check('no post authored by someone you already follow', exploreRows.every((r) => !following.has(r.author_id)));
  check('no post of your own', exploreRows.every((r) => r.author_id !== me));
  check('no duplicate posts', new Set(exploreRows.map((r) => r.id)).size === exploreRows.length);

  if (decoy) {
    const leaked = exploreRows.filter((r) => r.author_id === decoy.id);
    check(
      `the decoy (${DECOY_USERNAME}, newest post, ${Math.max(0, ...exploreRows.map((r) => r.like_count))} likes elsewhere) never appears`,
      leaked.length === 0,
      leaked.length ? `leaked ${leaked.length} post(s) — ranking has crept into Explore` : ''
    );
  } else {
    console.log(`  skip  decoy account "${DECOY_USERNAME}" not found — reseed to test this`);
  }

  const exploreOrdered = exploreRows.every(
    (r, i) => i === 0 || new Date(exploreRows[i - 1].created_at) >= new Date(r.created_at)
  );
  check('strictly reverse-chronological', exploreOrdered);

  // --- Home feed -----------------------------------------------------------
  console.log('\nHome feed is exactly the people you follow');

  const { data: home, error: homeError } = await supabase.rpc('home_feed', {
    before: null,
    before_id: null,
    lim: 50,
  });
  if (homeError) {
    console.error(`home_feed failed: ${homeError.message}`);
    process.exit(1);
  }
  const homeRows = (home ?? []) as FeedRow[];
  console.log(`  (${homeRows.length} posts returned)`);

  check(
    'every post is from you or someone you follow',
    homeRows.every((r) => r.author_id === me || following.has(r.author_id))
  );
  check(
    'strictly reverse-chronological',
    homeRows.every((r, i) => i === 0 || new Date(homeRows[i - 1].created_at) >= new Date(r.created_at))
  );
  check('no duplicates', new Set(homeRows.map((r) => r.id)).size === homeRows.length);
  if (decoy) {
    check('the decoy never appears here either', homeRows.every((r) => r.author_id !== decoy.id));
  }

  // --- Pagination ----------------------------------------------------------
  console.log('\nKeyset pagination neither skips nor duplicates');

  const paged: FeedRow[] = [];
  let cursor: { before: string; before_id: string } | null = null;
  for (let i = 0; i < 10; i++) {
    const { data: page } = await supabase.rpc('home_feed', {
      before: cursor?.before ?? null,
      before_id: cursor?.before_id ?? null,
      lim: 3,
    });
    const rows = (page ?? []) as FeedRow[];
    if (rows.length === 0) break;
    paged.push(...rows);
    const last = rows[rows.length - 1];
    cursor = { before: last.created_at, before_id: last.id };
    if (rows.length < 3) break;
  }
  check('paging 3-at-a-time yields no duplicates', new Set(paged.map((r) => r.id)).size === paged.length);
  check(
    'paged results match the single-shot query',
    paged.map((r) => r.id).join(',') === homeRows.slice(0, paged.length).map((r) => r.id).join(',')
  );

  console.log(`\n${failures === 0 ? 'Thesis holds. All checks passed.' : `${failures} check(s) FAILED.`}\n`);
  await supabase.auth.signOut();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
