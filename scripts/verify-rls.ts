/**
 * Two things the parse-only checks could never prove:
 *   1. the trigger-maintained counters actually match the rows
 *   2. RLS rejects cross-user writes when a real signed-in user attempts them
 */
/// <reference types="node" />
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
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let failed = 0;
const check = (label: string, pass: boolean, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? `  -- ${detail}` : ''}`);
};

async function main() {
  // ---------------------------------------------------------------- counters
  console.log('\nTrigger-maintained counters match reality\n');
  const { data: profiles } = await admin.from('profiles').select('id, username, post_count, follower_count, following_count');
  const { data: posts } = await admin.from('posts').select('id, author_id, like_count, comment_count');
  const { data: follows } = await admin.from('follows').select('follower_id, followee_id');
  const { data: likes } = await admin.from('likes').select('post_id');
  const { data: comments } = await admin.from('comments').select('post_id');

  const tally = <T>(rows: T[], key: (r: T) => string) =>
    rows.reduce<Record<string, number>>((m, r) => ((m[key(r)] = (m[key(r)] ?? 0) + 1), m), {});

  const postsBy = tally(posts!, (p) => p.author_id);
  const following = tally(follows!, (f) => f.follower_id);
  const followers = tally(follows!, (f) => f.followee_id);
  const likesOn = tally(likes!, (l) => l.post_id);
  const commentsOn = tally(comments!, (c) => c.post_id);

  for (const p of profiles!) {
    const decoy = p.username === 'viral_stranger';
    const bad: string[] = [];
    if (p.post_count !== (postsBy[p.id] ?? 0)) bad.push(`post_count ${p.post_count}≠${postsBy[p.id] ?? 0}`);
    if (p.following_count !== (following[p.id] ?? 0)) bad.push(`following ${p.following_count}≠${following[p.id] ?? 0}`);
    const fc = followers[p.id] ?? 0;
    if (p.follower_count !== fc) bad.push(`follower ${p.follower_count}≠${fc}`);
    if (decoy) {
      check(`${p.username} (decoy: counters deliberately forged)`, bad.length > 0, bad.join(', ') || 'expected forgery, found none');
    } else {
      check(`${p.username}`, bad.length === 0, bad.join(', '));
    }
  }

  let postBad = 0, decoyForged = 0;
  const decoyAuthor = profiles!.find((p) => p.username === 'viral_stranger')!.id;
  for (const p of posts!) {
    const mismatch = p.like_count !== (likesOn[p.id] ?? 0) || p.comment_count !== (commentsOn[p.id] ?? 0);
    if (!mismatch) continue;
    if (p.author_id === decoyAuthor) decoyForged++;
    else postBad++;
  }
  check(`all ${posts!.length} posts have accurate like/comment counts`, postBad === 0, `${postBad} mismatched`);
  check('decoy posts carry forged like_count (the fixture)', decoyForged > 0, `${decoyForged} forged`);

  // ------------------------------------------------------------------ RLS
  console.log('\nRLS rejects cross-user writes\n');
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;
  const asMaya = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error: sErr } = await asMaya.auth.signInWithPassword({ email: 'maya-dev@example.com', password: 'kalos2015' });
  if (sErr) throw new Error(`sign-in failed: ${sErr.message}`);
  const mayaId = (await asMaya.auth.getUser()).data.user!.id;
  const ishaan = profiles!.find((p) => p.username === 'ishaan')!;
  const ishaanPost = posts!.find((p) => p.author_id === ishaan.id)!;

  const denied = (error: unknown, data: unknown[] | null) => !!error || (data?.length ?? 0) === 0;
  /** RLS denies two different ways: a 42501 error, or a policy that matches no rows. */
  const how = (error: unknown, data: unknown[] | null) =>
    error ? `blocked (${(error as any).code ?? (error as any).message})`
          : (data?.length ?? 0) === 0 ? 'no rows matched the policy'
          : `${data!.length} row(s) WRITTEN`;

  {
    const { data, error } = await asMaya.from('posts').delete().eq('id', ishaanPost.id).select();
    check("can't delete someone else's post", denied(error, data), how(error, data));
  }
  {
    const { data, error } = await asMaya.from('likes').insert({ user_id: ishaan.id, post_id: ishaanPost.id }).select();
    check("can't like as another user", denied(error, data), how(error, data));
  }
  {
    const { data, error } = await asMaya.from('follows').insert({ follower_id: ishaan.id, followee_id: mayaId }).select();
    check("can't forge a follow from another user", denied(error, data), how(error, data));
  }
  {
    const { data, error } = await asMaya.from('profiles').update({ bio: 'pwned' }).eq('id', ishaan.id).select();
    check("can't edit another user's profile", denied(error, data), how(error, data));
  }
  {
    // The per-column grant: even on your OWN post, like_count is not yours to
    // set. If this write lands we have to undo it, or the test corrupts the
    // very counter the next check reads.
    const { data: mine } = await asMaya.from('posts').select('id').eq('author_id', mayaId).limit(1);
    const target = mine![0];
    // Recompute the truth from the like rows rather than trusting the column --
    // a previous failing run may have left a forged value sitting in it.
    const truth = likesOn[target.id] ?? 0;
    const { data, error } = await asMaya.from('posts').update({ like_count: 99999 }).eq('id', target.id).select();
    check("can't forge like_count on your own post", denied(error, data), how(error, data));
    if ((data?.length ?? 0) > 0) {
      await admin.from('posts').update({ like_count: truth }).eq('id', target.id);
      console.log(`       (restored like_count=${truth} on ${target.id})`);
    }
  }
  {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const { error } = await asMaya.storage.from('photos').upload(`${ishaan.id}/evil.jpg`, bytes, { contentType: 'image/jpeg' });
    check("can't upload into another user's storage folder", !!error, error ? `blocked (${error.message})` : 'UPLOAD SUCCEEDED');
  }

  console.log(failed === 0 ? '\nAll checks passed.\n' : `\n${failed} check(s) failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
