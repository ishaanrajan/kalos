/// <reference types="node" />
/**
 * Checks post_blocks (0031_post_blocks.sql) -- one account hiding their
 * posts from a specific other account, enforced in three independent
 * places (posts' own RLS, home_feed(), explore_feed()).
 *
 * Runs against three disposable throwaway accounts this script creates and
 * tears down itself: A (the blocker/post author), B (the blocked viewer),
 * and C (a third account, needed to give A's post a genuine "liked_by"
 * reason to appear in B's Explore before the block -- otherwise a
 * "does the block hide it" check would be meaningless if it was never
 * going to show up in the first place).
 *
 *   npx tsx scripts/verify-post-blocks.ts
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const raw of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq === -1) continue;
  process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
}
const url = process.env.SUPABASE_URL!;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let failed = 0;
const check = (l: string, pass: boolean, d = '') => {
  if (!pass) failed++;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${l}${d ? `  -- ${d}` : ''}`);
};

const stamp = Date.now();
async function signUp(tag: string) {
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signUp({
    email: `verify-post-blocks-${tag}-${stamp}@example.com`,
    password: 'kalos2015-verify',
  });
  if (error || !data.user) throw new Error(`signup ${tag} failed: ${error?.message}`);
  return { client, id: data.user.id };
}

async function main() {
  console.log('\nPost blocks\n');

  const a = await signUp('a');
  const b = await signUp('b');
  const c = await signUp('c');

  let postId: string | undefined;

  try {
    // --- setup: A posts, B follows C, C likes A's post, B follows A too ------
    // (B follows A so home_feed has something to hide; B follows C, not A,
    // for the explore_feed check, so both paths get a real pre-block signal
    // to lose rather than proving a negative that was never positive.)
    const { data: post, error: postErr } = await admin
      .from('posts')
      .insert({ author_id: a.id, image_path: 'verify/post-blocks-test.jpg' })
      .select('id')
      .single();
    if (postErr || !post) throw new Error(`could not create A's post: ${postErr?.message}`);
    postId = post.id as string;

    const { error: followAErr } = await admin.from('follows').insert({ follower_id: b.id, followee_id: a.id });
    if (followAErr) throw new Error(`b follow a failed: ${followAErr.message}`);
    const { error: followCErr } = await admin.from('follows').insert({ follower_id: b.id, followee_id: c.id });
    if (followCErr) throw new Error(`b follow c failed: ${followCErr.message}`);
    const { error: likeErr } = await admin.from('likes').insert({ post_id: postId, user_id: c.id });
    if (likeErr) throw new Error(`c like failed: ${likeErr.message}`);

    // --- before the block: B can see A's post every which way -----------------
    console.log('\nBefore the block\n');
    {
      const { data, error } = await b.client.from('posts').select('id').eq('id', postId);
      check('b can select a\'s post directly', !error && (data?.length ?? 0) === 1, error?.message ?? '');
    }
    {
      const { data } = await b.client.rpc('home_feed', { before: null, before_id: null, lim: 50 });
      const found = ((data ?? []) as Array<{ id: string }>).some((r) => r.id === postId);
      check('a\'s post appears in b\'s home_feed (b follows a)', found);
    }
    {
      const { data } = await b.client.rpc('explore_feed', { before: null, before_id: null, lim: 50 });
      const found = ((data ?? []) as Array<{ id: string; reason: string }>).some((r) => r.id === postId);
      check('a\'s post appears in b\'s explore_feed (liked by c, whom b follows)', found);
    }

    // --- a blocks b ------------------------------------------------------------
    const { error: blockErr } = await admin.from('post_blocks').insert({ blocker_id: a.id, blocked_id: b.id });
    if (blockErr) throw new Error(`could not create block: ${blockErr.message}`);

    console.log('\nAfter the block\n');
    {
      const { data, error } = await b.client.from('posts').select('id').eq('id', postId);
      check('b can no longer select a\'s post directly', !error && (data?.length ?? 0) === 0, `${data?.length ?? 0} row(s) visible`);
    }
    {
      const { data } = await b.client.rpc('home_feed', { before: null, before_id: null, lim: 50 });
      const found = ((data ?? []) as Array<{ id: string }>).some((r) => r.id === postId);
      check('a\'s post no longer appears in b\'s home_feed', !found);
    }
    {
      const { data } = await b.client.rpc('explore_feed', { before: null, before_id: null, lim: 50 });
      const found = ((data ?? []) as Array<{ id: string }>).some((r) => r.id === postId);
      check('a\'s post no longer appears in b\'s explore_feed', !found);
    }
    {
      // The block is one-directional -- a should still see their own post
      // fine, and c (uninvolved) should be untouched.
      const { data, error } = await a.client.from('posts').select('id').eq('id', postId);
      check('a (the blocker) can still see their own post', !error && (data?.length ?? 0) === 1, error?.message ?? '');
    }
    {
      const { data, error } = await c.client.from('posts').select('id').eq('id', postId);
      check('c (uninvolved) is unaffected', !error && (data?.length ?? 0) === 1, error?.message ?? '');
    }
  } finally {
    if (postId) {
      await admin.from('post_blocks').delete().eq('blocker_id', a.id).eq('blocked_id', b.id);
      await admin.from('likes').delete().eq('post_id', postId).eq('user_id', c.id);
      await admin.from('follows').delete().eq('follower_id', b.id).in('followee_id', [a.id, c.id]);
      const { error } = await admin.from('posts').delete().eq('id', postId);
      if (error) console.error(`  !! could not clean up test post ${postId}: ${error.message}`);
    }
    for (const { id, client } of [a, b, c]) {
      client.removeAllChannels?.();
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) console.error(`  !! could not clean up test user ${id}: ${error.message}`);
    }
  }

  console.log(failed === 0 ? '\nPost blocks are wired correctly.\n' : `\n${failed} failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
