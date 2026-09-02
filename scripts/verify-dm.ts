/**
 * DMs are deliberately narrow: every thread is with "ishaan", identified by
 * thread_user_id rather than a separate conversations table. This checks the
 * two things that matter -- a regular user is boxed into exactly their own
 * thread, and ishaan can see and reply into anyone's -- against the real,
 * signed-in-as-two-different-users database, not just by reading the SQL.
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
const asMaya = createClient(url, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
const asIshaan = createClient(url, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });

let failed = 0;
const check = (label: string, pass: boolean, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? `  -- ${detail}` : ''}`);
};
const denied = (error: unknown, data: unknown[] | null) => !!error || (data?.length ?? 0) === 0;
const how = (error: unknown, data: unknown[] | null) =>
  error ? `blocked (${(error as any).code ?? (error as any).message})`
        : (data?.length ?? 0) === 0 ? 'no rows matched the policy'
        : `${data!.length} row(s) WRITTEN`;

async function main() {
  const { error: mErr } = await asMaya.auth.signInWithPassword({ email: 'maya-dev@example.com', password: 'kalos2015' });
  if (mErr) throw new Error(mErr.message);
  const { error: iErr } = await asIshaan.auth.signInWithPassword({ email: 'ishaan@example.com', password: 'kalos2015' });
  if (iErr) throw new Error(iErr.message);

  const mayaId = (await asMaya.auth.getUser()).data.user!.id;
  const ishaanId = (await asIshaan.auth.getUser()).data.user!.id;
  const { data: third } = await admin.from('profiles').select('id, username').neq('id', mayaId).neq('username', 'ishaan').limit(1).single();
  const thirdId = third!.id;

  const seeded: string[] = [];

  console.log('\nWhat a regular user can and cannot do\n');
  {
    const { data, error } = await asMaya.from('dm_messages')
      .insert({ thread_user_id: mayaId, sender_id: mayaId, body: 'verify: maya into her own thread' }).select();
    check('send into your own thread', !error && !!data?.length, error?.message ?? '');
    if (data?.length) seeded.push(data[0].id);
  }
  {
    const { data, error } = await asMaya.from('dm_messages')
      .insert({ thread_user_id: thirdId, sender_id: mayaId, body: 'verify: forged thread' }).select();
    check("can't write into someone else's thread", denied(error, data), how(error, data));
    if (data?.length) seeded.push(data[0].id);
  }
  {
    const { data, error } = await asMaya.from('dm_messages')
      .insert({ thread_user_id: mayaId, sender_id: ishaanId, body: 'verify: impersonating ishaan' }).select();
    check("can't send as another user", denied(error, data), how(error, data));
    if (data?.length) seeded.push(data[0].id);
  }
  {
    // Seed a message in a thread maya has no part in, then confirm she can't see it.
    const { data: seed } = await admin.from('dm_messages')
      .insert({ thread_user_id: thirdId, sender_id: thirdId, body: 'verify: not maya\'s business' }).select();
    if (seed?.length) seeded.push(seed[0].id);
    const { data, error } = await asMaya.from('dm_messages').select('*').eq('thread_user_id', thirdId);
    check("can't read someone else's thread", !error && (data?.length ?? 0) === 0, `${data?.length ?? 0} row(s) visible`);
  }
  {
    const { data, error } = await asMaya.from('dm_messages').update({ body: 'hacked' }).eq('thread_user_id', mayaId).select();
    check("can't edit a message after sending (no update policy)", denied(error, data), how(error, data));
  }
  {
    const { data, error } = await asMaya.rpc('dm_inbox', { lim: 10 });
    check('dm_inbox() is empty for a non-ishaan caller', !error && (data?.length ?? 0) === 0, `${data?.length ?? 0} row(s)`);
  }

  console.log('\nWhat ishaan can do\n');
  {
    const { data, error } = await asIshaan.from('dm_messages')
      .insert({ thread_user_id: mayaId, sender_id: ishaanId, body: 'verify: ishaan replying' }).select();
    check("reply into maya's thread", !error && !!data?.length, error?.message ?? '');
    if (data?.length) seeded.push(data[0].id);
  }
  {
    const { data, error } = await asIshaan.from('dm_messages').select('*').eq('thread_user_id', mayaId);
    check("read maya's thread", !error && (data?.length ?? 0) >= 2, `${data?.length ?? 0} row(s)`);
  }
  {
    const { data, error } = await asIshaan.rpc('dm_inbox', { lim: 50 });
    const row = (data ?? []).find((r: any) => r.thread_user_id === mayaId);
    check('dm_inbox() lists maya as a thread', !error && !!row, error?.message ?? (row ? 'found' : 'not found'));
  }

  if (seeded.length) await admin.from('dm_messages').delete().in('id', seeded);
  console.log(failed === 0 ? '\nAll DM checks passed.\n' : `\n${failed} failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
