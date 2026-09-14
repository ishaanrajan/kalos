/// <reference types="node" />
/**
 * Checks for music on posts (0024_post_music.sql, 0028_music_everyone.sql).
 *
 * Runs against a disposable throwaway account this script signs up and
 * deletes itself, not a pre-seeded fixture -- this project's live database
 * was seeded with real accounts, not scripts/seed.ts's synthetic ones, so a
 * hardcoded `maya-dev@example.com` login would just fail here.
 *
 * Five things have to hold, and four of them are only observable against a
 * real database:
 *
 *   0. A non-ishaan account can actually insert a post with music --
 *      posts_insert_own itself, not just the shape constraint below.
 *   1. The `music` column exists and its shape constraint actually rejects a
 *      half-built object -- the constraint is the entire reason the client can
 *      treat post.music as all-or-nothing.
 *   2. Both feed RPCs return it. They hand-list their return columns, so a
 *      migration that adds the column but forgets the functions leaves the
 *      feature silently invisible in the feed.
 *   3. The column is NOT client-writable after the fact. Unlike caption,
 *      music is chosen at capture time, and 0004's column-level grants are
 *      what enforce that.
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

  const email = `verify-music-${Date.now()}@example.com`;
  const { data: signUp, error: signUpErr } = await c.auth.signUp({ email, password: 'kalos2015-verify' });
  if (signUpErr || !signUp.user) throw new Error(`signup failed: ${signUpErr?.message}`);
  const me = signUp.user.id;

  let postId: string | undefined;

  try {
    // --- 0. a non-ishaan account can actually post with music (0028) --------
    // Everything below this uses a service-role client for setup/teardown,
    // which bypasses RLS entirely -- it would not have caught
    // 0025_music_ishaan_only.sql's restriction, or a regression of its
    // repeal. This is the one check that inserts through posts_insert_own
    // itself, signed in as a real, non-privileged, freshly-created user, the
    // same way verify-dm.ts proves RLS by acting as real users rather than
    // trusting the policy SQL by inspection. The resulting post also
    // supplies postId for every check below -- no pre-seeded fixture needed.
    {
      const { data, error } = await c
        .from('posts')
        .insert({ author_id: me, image_path: 'verify/music-everyone-test.jpg', music: SAMPLE })
        .select('id')
        .single();
      check('a non-ishaan account can insert a post with music', !error && !!data, error?.message ?? '');
      postId = data?.id;
    }

    if (!postId) {
      console.log('\nCould not create a test post -- nothing further to check.\n');
      process.exit(1);
    }

    // --- 1. shape constraint --------------------------------------------------
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
    // Put a valid object back -- the two rejected updates above never wrote,
    // but this keeps the row in a known-good state regardless.
    {
      const { error } = await admin.from('posts').update({ music: SAMPLE }).eq('id', postId);
      check('a complete music object is accepted', !error, error?.message ?? '');
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
    if (postId) {
      const { error } = await admin.from('posts').delete().eq('id', postId);
      if (error) console.error(`  !! could not clean up test post ${postId}: ${error.message}`);
    }
    const { error: delUserErr } = await admin.auth.admin.deleteUser(me);
    if (delUserErr) console.error(`  !! could not clean up test user ${me}: ${delUserErr.message}`);
  }

  console.log(failed === 0 ? '\nMusic on posts is wired correctly.\n' : `\n${failed} failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
