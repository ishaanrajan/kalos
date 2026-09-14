/// <reference types="node" />
/**
 * Checks for music on posts (0024_post_music.sql).
 *
 * Four things have to hold, and three of them are only observable against a
 * real database:
 *
 *   1. The `music` column exists and its shape constraint actually rejects a
 *      half-built object -- the constraint is the entire reason the client can
 *      treat post.music as all-or-nothing.
 *   2. Both feed RPCs return it. They hand-list their return columns, so a
 *      migration that adds the column but forgets the functions leaves the
 *      feature silently invisible in the feed.
 *   3. The column is NOT client-writable. Unlike caption, music is chosen at
 *      capture time, and 0004's column-level grants are what enforce that.
 *   4. The catalog itself still returns playable previews.
 *
 *   npx tsx scripts/verify-music.ts
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchTracks } from '../lib/music';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const raw of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq === -1) continue;
  process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
}
const url = process.env.SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const c = createClient(url, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });

let failed = 0;
const check = (l: string, pass: boolean, d = '') => {
  if (!pass) failed++;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${l}${d ? `  -- ${d}` : ''}`);
};

const SAMPLE = {
  track_id: '1440857781',
  title: 'Dreams',
  artist: 'Fleetwood Mac',
  artwork_url: null,
  preview_url: 'https://example.invalid/preview.m4a',
  store_url: 'https://music.apple.com/us/album/dreams/1440857625?i=1440857781',
  start_ms: 8000,
};

async function main() {
  console.log('\nMusic on posts\n');

  const { error: se } = await c.auth.signInWithPassword({
    email: 'maya-dev@example.com',
    password: 'kalos2015',
  });
  if (se) throw new Error(se.message);
  const me = (await c.auth.getUser()).data.user!.id;

  // --- 0. a non-ishaan account can actually post with music (0028) --------
  // Everything below this block exercises the shape constraint via the
  // service-role client, which bypasses RLS entirely -- it would not have
  // caught 0025_music_ishaan_only.sql's restriction, or a regression of its
  // repeal in 0028_music_everyone.sql. This is the one check that signs in
  // as a real, non-privileged user and inserts through posts_insert_own
  // itself, the same way verify-dm.ts proves RLS by acting as two real users
  // rather than trusting the policy SQL by inspection.
  {
    const { data, error } = await c
      .from('posts')
      .insert({ author_id: me, image_path: 'verify/music-everyone-test.jpg', music: SAMPLE })
      .select('id')
      .single();
    check('a non-ishaan account can insert a post with music', !error && !!data, error?.message ?? '');
    if (data?.id) {
      const { error: delErr } = await admin.from('posts').delete().eq('id', data.id);
      if (delErr) console.error(`  !! could not clean up test post ${data.id}: ${delErr.message}`);
    }
  }

  // --- 1. column + shape constraint ----------------------------------------
  const { data: own } = await admin
    .from('posts')
    .select('id, music')
    .eq('author_id', me)
    .limit(1);
  const postId = own?.[0]?.id as string | undefined;
  check('posts.music column is selectable', !!own, 'no rows for the test user');
  if (!postId) {
    console.log('\nNo post to test against -- run `npm run seed` first.\n');
    process.exit(1);
  }

  // This writes to a real row, so remember what was there and put it back no
  // matter how the run ends. Nulling it unconditionally would quietly strip
  // music off a genuine post.
  const original = own![0].music ?? null;

  try {
  {
    const { error } = await admin.from('posts').update({ music: SAMPLE }).eq('id', postId);
    check('a complete music object is accepted', !error, error?.message ?? '');
  }
  {
    // Missing preview_url -- exactly the half-attached state the constraint exists to stop.
    const { error } = await admin
      .from('posts')
      .update({ music: { track_id: '1', title: 'x', artist: 'y', store_url: 'z', start_ms: 0 } })
      .eq('id', postId);
    check('an incomplete music object is rejected', !!error, error ? '' : 'the check constraint did not fire');
  }
  {
    const { error } = await admin
      .from('posts')
      .update({ music: { ...SAMPLE, start_ms: 'soon' } })
      .eq('id', postId);
    check('a non-numeric start_ms is rejected', !!error, error ? '' : 'the check constraint did not fire');
  }

  // --- 2. both feed RPCs carry it ------------------------------------------
  for (const fn of ['home_feed', 'explore_feed'] as const) {
    const { data, error } = await c.rpc(fn, { before: null, before_id: null, lim: 12 });
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    check(`rpc ${fn} succeeds`, !error, error?.message ?? '');
    check(
      `rpc ${fn} returns a music column`,
      rows.length === 0 || 'music' in rows[0],
      rows.length === 0 ? 'no rows to inspect' : `keys: ${Object.keys(rows[0]).join(', ')}`,
    );
  }
  {
    const { data } = await c.rpc('home_feed', { before: null, before_id: null, lim: 50 });
    const row = ((data ?? []) as Array<{ id: string; music: unknown }>).find((r) => r.id === postId);
    const music = row?.music as typeof SAMPLE | undefined;
    check(
      'a post\'s music round-trips through home_feed',
      !!music && music.track_id === SAMPLE.track_id && music.start_ms === SAMPLE.start_ms,
      music ? JSON.stringify(music) : 'post not visible in the viewer\'s own feed',
    );
  }

  // --- 3. not client-writable ----------------------------------------------
  {
    // 0004_rls.sql grants update only on (caption, filter_name). A client
    // writing music -- even to its own post -- must be refused.
    const { error } = await c.from('posts').update({ music: SAMPLE }).eq('id', postId);
    check('a signed-in author cannot rewrite music from the client', !!error,
          error ? '' : 'the column-level grant is wider than intended');
  }

  // --- 4. the catalog still serves previews ---------------------------------
  {
    try {
      const tracks = await searchTracks('fleetwood mac dreams');
      check('catalog search returns results', tracks.length > 0, `${tracks.length} tracks`);
      check(
        'every returned track has a playable preview',
        tracks.length > 0 && tracks.every((t) => !!t.previewUrl),
        'a track without previewUrl reached the picker',
      );
    } catch (e) {
      check('catalog search returns results', false, e instanceof Error ? e.message : String(e));
    }
  }

  } finally {
    // Always -- a thrown check must not leave test data on a real post.
    const { error } = await admin.from('posts').update({ music: original }).eq('id', postId);
    if (error) console.error(`  !! could not restore music on ${postId}: ${error.message}`);
  }

  console.log(failed === 0 ? '\nMusic on posts is wired correctly.\n' : `\n${failed} failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
