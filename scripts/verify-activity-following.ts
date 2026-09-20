/// <reference types="node" />
/**
 * Checks activity_feed_following() (0036_activity_following_feed.sql): the
 * "FOLLOWING" tab -- likes/comments by people you follow, on posts that
 * aren't your own, graph-derived only, honoring post_blocks.
 *
 * Four throwaway accounts, created and deleted here: A (the viewer), B
 * (followed by A), C (a stranger A does not follow), P (the post's author,
 * kept separate so "B liked P's post" and "B is who A follows" aren't
 * conflated with A's own posts).
 *
 *   npx tsx scripts/verify-activity-following.ts
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
    email: `verify-activity-following-${tag}-${stamp}@example.com`,
    password: 'kalos2015-verify',
  });
  if (error || !data.user) throw new Error(`signup ${tag} failed: ${error?.message}`);
  return { client, id: data.user.id };
}

type Row = { kind: string; post_id: string | null; actor: { username: string } };

async function main() {
  console.log('\nActivity: FOLLOWING tab\n');

  const a = await signUp('a');
  const b = await signUp('b');
  const c = await signUp('c');
  const p = await signUp('p');

  let postId: string | undefined;
  let ownPostId: string | undefined;

  try {
    const { data: bProfile } = await admin.from('profiles').select('username').eq('id', b.id).single();
    const bUsername = bProfile?.username as string;

    // --- setup -----------------------------------------------------------------
    const { data: post, error: postErr } = await admin
      .from('posts')
      .insert({ author_id: p.id, image_path: 'verify/activity-following-test.jpg' })
      .select('id')
      .single();
    if (postErr || !post) throw new Error(`could not create P's post: ${postErr?.message}`);
    postId = post.id as string;

    const { data: ownPost, error: ownPostErr } = await admin
      .from('posts')
      .insert({ author_id: a.id, image_path: 'verify/activity-following-own-test.jpg' })
      .select('id')
      .single();
    if (ownPostErr || !ownPost) throw new Error(`could not create A's own post: ${ownPostErr?.message}`);
    ownPostId = ownPost.id as string;

    const { error: followErr } = await admin.from('follows').insert({ follower_id: a.id, followee_id: b.id });
    if (followErr) throw new Error(`a follow b failed: ${followErr.message}`);

    const { error: likeErr } = await admin.from('likes').insert({ post_id: postId, user_id: b.id });
    if (likeErr) throw new Error(`b like failed: ${likeErr.message}`);
    const { error: commentErr } = await admin
      .from('comments')
      .insert({ post_id: postId, author_id: b.id, body: 'nice' });
    if (commentErr) throw new Error(`b comment failed: ${commentErr.message}`);
    const { error: strangerLikeErr } = await admin.from('likes').insert({ post_id: postId, user_id: c.id });
    if (strangerLikeErr) throw new Error(`c like failed: ${strangerLikeErr.message}`);
    const { error: ownLikeErr } = await admin.from('likes').insert({ post_id: ownPostId, user_id: b.id });
    if (ownLikeErr) throw new Error(`b like on a's own post failed: ${ownLikeErr.message}`);

    // --- reading -----------------------------------------------------------------
    console.log('\nBefore any block\n');
    {
      const { data } = await a.client.rpc('activity_feed_following', { lim: 50 });
      const rows = (data ?? []) as Row[];
      const like = rows.find((r) => r.kind === 'like' && r.post_id === postId);
      const comment = rows.find((r) => r.kind === 'comment' && r.post_id === postId);
      check("b's like on p's post appears", like?.actor?.username === bUsername, JSON.stringify(like));
      check("b's comment on p's post appears", comment?.actor?.username === bUsername, JSON.stringify(comment));
      check(
        "c's like does not appear (c not followed)",
        !rows.some((r) => r.kind === 'like' && r.post_id === postId && r.actor?.username !== bUsername),
      );
      check(
        "b's like on a's own post does not appear (own-post exclusion)",
        !rows.some((r) => r.post_id === ownPostId),
      );
    }

    // --- p blocks a ------------------------------------------------------------
    const { error: blockErr } = await admin.from('post_blocks').insert({ blocker_id: p.id, blocked_id: a.id });
    if (blockErr) throw new Error(`could not create block: ${blockErr.message}`);

    console.log('\nAfter p blocks a\n');
    {
      const { data } = await a.client.rpc('activity_feed_following', { lim: 50 });
      const rows = (data ?? []) as Row[];
      check("b's activity on p's post disappears once p blocks a", !rows.some((r) => r.post_id === postId));
    }
  } finally {
    if (postId) {
      await admin.from('post_blocks').delete().eq('blocker_id', p.id).eq('blocked_id', a.id);
      await admin.from('follows').delete().eq('follower_id', a.id).eq('followee_id', b.id);
      const { error } = await admin.from('posts').delete().in('id', [postId, ownPostId].filter(Boolean));
      if (error) console.error(`  !! could not clean up test posts: ${error.message}`);
    }
    for (const { id } of [a, b, c, p]) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) console.error(`  !! could not clean up test user ${id}: ${error.message}`);
    }
  }

  console.log(failed === 0 ? '\nFOLLOWING activity is wired correctly.\n' : `\n${failed} failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
