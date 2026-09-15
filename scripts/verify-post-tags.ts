/// <reference types="node" />
/**
 * Checks post_tags (0034_post_tags.sql): who may tag, who may see a tag,
 * that the feeds carry tags, that activity_feed() surfaces a 'tag' row for
 * the tagged account, and that post_blocks hides all of it from an account
 * the author has blocked.
 *
 * Four throwaway accounts, created and deleted here: A (the author), B
 * (tagged; follows A, so A's post is in B's home feed), C (an uninvolved
 * viewer), D (tagged too, then blocked by A).
 *
 *   npx tsx scripts/verify-post-tags.ts
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
    email: `verify-post-tags-${tag}-${stamp}@example.com`,
    password: 'kalos2015-verify',
  });
  if (error || !data.user) throw new Error(`signup ${tag} failed: ${error?.message}`);
  return { client, id: data.user.id };
}

type Tag = { user_id: string; username: string; x: number; y: number };
type FeedRow = { id: string; tags?: Tag[] };
type ActivityRow = { kind: string; post_id: string | null; actor: { username: string } };

async function main() {
  console.log('\nPost tags\n');

  const a = await signUp('a');
  const b = await signUp('b');
  const c = await signUp('c');
  const d = await signUp('d');

  let postId: string | undefined;

  try {
    // --- setup -----------------------------------------------------------------
    const { data: post, error: postErr } = await admin
      .from('posts')
      .insert({ author_id: a.id, image_path: 'verify/post-tags-test.jpg' })
      .select('id')
      .single();
    if (postErr || !post) throw new Error(`could not create A's post: ${postErr?.message}`);
    postId = post.id as string;

    const { error: followErr } = await admin.from('follows').insert({ follower_id: b.id, followee_id: a.id });
    if (followErr) throw new Error(`b follow a failed: ${followErr.message}`);

    const { data: bProfile } = await admin.from('profiles').select('username').eq('id', b.id).single();
    const bUsername = bProfile?.username as string;
    const { data: aProfile } = await admin.from('profiles').select('username').eq('id', a.id).single();
    const aUsername = aProfile?.username as string;

    // --- writing ---------------------------------------------------------------
    console.log('\nWriting\n');
    {
      const { error } = await a.client
        .from('post_tags')
        .insert({ post_id: postId, user_id: b.id, x: 0.25, y: 0.75 });
      check('a (author) can tag b on their post', !error, error?.message ?? '');
    }
    {
      const { error } = await b.client
        .from('post_tags')
        .insert({ post_id: postId, user_id: c.id, x: 0.5, y: 0.5 });
      check('b (not the author) cannot tag anyone on a\'s post', !!error, error ? '' : 'insert succeeded');
    }
    {
      const { error } = await a.client
        .from('post_tags')
        .insert({ post_id: postId, user_id: c.id, x: 1.5, y: 0.5 });
      check('x outside 0..1 is rejected', error?.code === '23514', error?.code ?? 'insert succeeded');
    }
    {
      const { error } = await a.client
        .from('post_tags')
        .insert({ post_id: postId, user_id: d.id, x: 0.9, y: 0.1 });
      check('a can tag d too', !error, error?.message ?? '');
    }

    // --- reading ---------------------------------------------------------------
    console.log('\nReading\n');
    {
      const { data, error } = await c.client.from('post_tags').select('user_id').eq('post_id', postId);
      check('c (uninvolved) sees both tags on a visible post', !error && data?.length === 2, error?.message ?? `${data?.length} row(s)`);
    }
    {
      const { data, error } = await c.client
        .from('post_tags')
        .select('user_id, x, y, user:profiles!post_tags_user_id_fkey(username)')
        .eq('post_id', postId)
        .order('created_at', { ascending: true });
      const first = (data ?? [])[0] as { user?: { username?: string } } | undefined;
      check('the usePost embed resolves the tagged username', !error && first?.user?.username === bUsername, error?.message ?? JSON.stringify(first));
    }
    {
      const { data } = await b.client.rpc('home_feed', { before: null, before_id: null, lim: 50 });
      const row = ((data ?? []) as FeedRow[]).find((r) => r.id === postId);
      const tag = row?.tags?.find((t) => t.user_id === b.id);
      check('home_feed row carries tags with username and coordinates', tag?.username === bUsername && tag?.x === 0.25 && tag?.y === 0.75, JSON.stringify(row?.tags));
    }
    {
      const { data, error } = await c.client.rpc('explore_feed', { before: null, before_id: null, lim: 5 });
      const rows = (data ?? []) as FeedRow[];
      check('explore_feed runs and every row has a tags array', !error && rows.every((r) => Array.isArray(r.tags)), error?.message ?? `${rows.length} row(s)`);
    }
    {
      const { data, error } = await b.client
        .from('post_tags')
        .select('created_at, post:posts!post_tags_post_id_fkey(id)')
        .eq('user_id', b.id);
      // supabase-js can't tell a to-one embed from a to-many without generated
      // types, so it infers an array here; at runtime it's one object.
      const rows = (data ?? []) as unknown as Array<{ post: { id: string } | null }>;
      check('"Photos of you" query returns a\'s post for b', !error && rows.some((r) => r.post?.id === postId), error?.message ?? JSON.stringify(rows));
    }
    {
      const { data } = await b.client.rpc('activity_feed', { lim: 50 });
      const row = ((data ?? []) as ActivityRow[]).find((r) => r.kind === 'tag' && r.post_id === postId);
      check('b\'s activity_feed has a tag row with a as the actor', row?.actor?.username === aUsername, JSON.stringify(row));
    }
    {
      const { data } = await a.client.rpc('activity_feed', { lim: 50 });
      const row = ((data ?? []) as ActivityRow[]).find((r) => r.kind === 'tag');
      check('a\'s own activity_feed has no tag row', !row);
    }

    // --- a blocks d ------------------------------------------------------------
    const { error: blockErr } = await admin.from('post_blocks').insert({ blocker_id: a.id, blocked_id: d.id });
    if (blockErr) throw new Error(`could not create block: ${blockErr.message}`);

    console.log('\nAfter a blocks d\n');
    {
      const { data, error } = await d.client.from('post_tags').select('user_id').eq('post_id', postId);
      check('d can no longer read tags on a\'s post', !error && data?.length === 0, error?.message ?? `${data?.length} row(s)`);
    }
    {
      const { data } = await d.client.rpc('activity_feed', { lim: 50 });
      const row = ((data ?? []) as ActivityRow[]).find((r) => r.kind === 'tag' && r.post_id === postId);
      check('d\'s activity_feed has no tag row for a\'s post', !row);
    }
    {
      const { data: blocked } = await admin.rpc('post_blocked', { author: a.id, viewer: d.id });
      check('notify\'s post_blocked check would suppress d\'s push', blocked === true, String(blocked));
    }

    // --- deleting ----------------------------------------------------------------
    console.log('\nDeleting\n');
    {
      const { error, count } = await c.client
        .from('post_tags')
        .delete({ count: 'exact' })
        .eq('post_id', postId)
        .eq('user_id', b.id);
      check('c cannot remove b\'s tag', !error && (count ?? 0) === 0, error?.message ?? `${count} deleted`);
    }
    {
      const { error, count } = await b.client
        .from('post_tags')
        .delete({ count: 'exact' })
        .eq('post_id', postId)
        .eq('user_id', b.id);
      check('b can remove their own tag', !error && count === 1, error?.message ?? `${count} deleted`);
    }
    {
      const { error, count } = await a.client
        .from('post_tags')
        .delete({ count: 'exact' })
        .eq('post_id', postId)
        .eq('user_id', d.id);
      check('a (author) can remove d\'s tag', !error && count === 1, error?.message ?? `${count} deleted`);
    }
  } finally {
    if (postId) {
      await admin.from('post_blocks').delete().eq('blocker_id', a.id).eq('blocked_id', d.id);
      await admin.from('follows').delete().eq('follower_id', b.id).eq('followee_id', a.id);
      // Tags cascade with the post.
      const { error } = await admin.from('posts').delete().eq('id', postId);
      if (error) console.error(`  !! could not clean up test post ${postId}: ${error.message}`);
    }
    for (const { id } of [a, b, c, d]) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) console.error(`  !! could not clean up test user ${id}: ${error.message}`);
    }
  }

  console.log(failed === 0 ? '\nPost tags are wired correctly.\n' : `\n${failed} failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
