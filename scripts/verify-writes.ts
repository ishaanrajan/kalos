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
const c = createClient(url, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });

let failed = 0;
const check = (l: string, pass: boolean, d = '') => { if (!pass) failed++; console.log(`${pass ? '  ok  ' : ' FAIL '} ${l}${d ? `  -- ${d}` : ''}`); };

async function main() {
  const { error: se } = await c.auth.signInWithPassword({ email: 'maya-dev@example.com', password: 'kalos2015' });
  if (se) throw new Error(se.message);
  const me = (await c.auth.getUser()).data.user!.id;

  console.log('\nThings the app must still be able to do\n');

  // a post by someone maya does not already like
  const { data: cand } = await admin.from('posts').select('id, author_id, like_count').neq('author_id', me).limit(50);
  const { data: mine } = await admin.from('likes').select('post_id').eq('user_id', me);
  const liked = new Set((mine ?? []).map((l) => l.post_id));
  const target = cand!.find((p) => !liked.has(p.id))!;

  {
    const { error } = await c.from('likes').insert({ user_id: me, post_id: target.id });
    check('like a post', !error, error?.message ?? '');
    const { data: after } = await admin.from('posts').select('like_count').eq('id', target.id).single();
    check('like trigger bumped like_count', after!.like_count === target.like_count + 1,
          `${target.like_count} -> ${after!.like_count}`);
    const { error: ue } = await c.from('likes').delete().eq('user_id', me).eq('post_id', target.id);
    check('unlike it again', !ue, ue?.message ?? '');
    const { data: back } = await admin.from('posts').select('like_count').eq('id', target.id).single();
    check('unlike trigger restored like_count', back!.like_count === target.like_count, `back to ${back!.like_count}`);
  }
  {
    const { data, error } = await c.from('comments').insert({ post_id: target.id, author_id: me, body: 'verify' }).select();
    check('comment on a post', !error && !!data?.length, error?.message ?? '');
    if (data?.length) await c.from('comments').delete().eq('id', data[0].id);
  }
  {
    const { data: myPost } = await admin.from('posts').select('id, caption').eq('author_id', me).limit(1).single();
    const { data, error } = await c.from('posts').update({ caption: myPost!.caption }).eq('id', myPost!.id).select();
    check('edit your own caption', !error && !!data?.length, error?.message ?? `${data?.length ?? 0} row updated`);
  }
  {
    const { data: prof } = await admin.from('profiles').select('bio').eq('id', me).single();
    const { data, error } = await c.from('profiles').update({ bio: prof!.bio }).eq('id', me).select();
    check('edit your own bio', !error && !!data?.length, error?.message ?? `${data?.length ?? 0} row updated`);
  }
  {
    const other = cand!.find((p) => p.author_id !== me)!.author_id;
    const { data: existing } = await admin.from('follows').select('*').eq('follower_id', me).eq('followee_id', other);
    if (existing?.length) {
      check('follow (already following; skipped)', true, 'n/a');
    } else {
      const { error } = await c.from('follows').insert({ follower_id: me, followee_id: other });
      check('follow someone', !error, error?.message ?? '');
      if (!error) await c.from('follows').delete().eq('follower_id', me).eq('followee_id', other);
    }
  }
  {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const key = `${me}/verify-${Date.now()}.jpg`;
    const { error } = await c.storage.from('photos').upload(key, bytes, { contentType: 'image/jpeg' });
    check('upload into your own storage folder', !error, error?.message ?? '');
    if (!error) await admin.storage.from('photos').remove([key]);
  }
  for (const [fn, args] of [['home_feed', { before: null, before_id: null, lim: 3 }], ['explore_feed', { before: null, before_id: null, lim: 3 }], ['activity_feed', { lim: 5 }], ['search_profiles', { q: 'ma', lim: 5 }]] as const) {
    const { data, error } = await c.rpc(fn, args as any);
    check(`rpc ${fn} as a signed-in user`, !error, error?.message ?? `${(data as any[])?.length ?? 0} rows`);
  }

  console.log(failed === 0 ? '\nAll allowed operations work.\n' : `\n${failed} failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
