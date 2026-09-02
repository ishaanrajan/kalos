/**
 * RLS checks for 0009_notifications.sql: push_tokens (own-rows-only), and the
 * two read-tracking columns -- dm_messages.read_at (recipient can set it, the
 * sender can't, and only on their own thread) and profiles.activity_read_at
 * (only your own).
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
  const cleanupTokens: string[] = [];
  const cleanupMessages: string[] = [];

  console.log('\npush_tokens\n');
  {
    const token = `verify-${Date.now()}-maya`;
    const { data, error } = await asMaya.from('push_tokens')
      .insert({ user_id: mayaId, token, platform: 'ios' }).select();
    check('register your own device token', !error && !!data?.length, error?.message ?? '');
    if (data?.length) cleanupTokens.push(data[0].id);
  }
  {
    const token = `verify-${Date.now()}-forged`;
    const { data, error } = await asMaya.from('push_tokens')
      .insert({ user_id: ishaanId, token, platform: 'ios' }).select();
    check("can't register a token for someone else", denied(error, data), how(error, data));
    if (data?.length) cleanupTokens.push(data[0].id);
  }
  {
    const { data, error } = await asMaya.from('push_tokens').select('*').eq('user_id', ishaanId);
    check("can't read someone else's tokens", !error && (data?.length ?? 0) === 0, `${data?.length ?? 0} row(s) visible`);
  }

  console.log('\ndm_messages.read_at\n');
  {
    const { data: seed } = await admin.from('dm_messages')
      .insert({ thread_user_id: mayaId, sender_id: ishaanId, body: 'verify: read receipt check' }).select();
    const msgId = seed![0].id;
    cleanupMessages.push(msgId);

    const { data: bySender, error: senderErr } = await asIshaan.from('dm_messages')
      .update({ read_at: new Date().toISOString() }).eq('id', msgId).select();
    check("sender can't mark their own message read", denied(senderErr, bySender), how(senderErr, bySender));

    const { data: byRecipient, error: recipientErr } = await asMaya.from('dm_messages')
      .update({ read_at: new Date().toISOString() }).eq('id', msgId).select();
    check('recipient can mark it read', !recipientErr && !!byRecipient?.length, recipientErr?.message ?? '');
  }
  {
    const { data: third } = await admin.from('profiles').select('id').neq('id', mayaId).neq('username', 'ishaan').limit(1).single();
    const { data: seed } = await admin.from('dm_messages')
      .insert({ thread_user_id: third!.id, sender_id: ishaanId, body: 'verify: not maya\'s thread' }).select();
    cleanupMessages.push(seed![0].id);
    const { data, error } = await asMaya.from('dm_messages')
      .update({ read_at: new Date().toISOString() }).eq('id', seed![0].id).select();
    check("can't mark someone else's thread read", denied(error, data), how(error, data));
  }

  console.log('\nprofiles.activity_read_at\n');
  {
    const { data, error } = await asMaya.from('profiles')
      .update({ activity_read_at: new Date().toISOString() }).eq('id', mayaId).select();
    check('update your own activity_read_at', !error && !!data?.length, error?.message ?? '');
  }
  {
    const { data, error } = await asMaya.from('profiles')
      .update({ activity_read_at: new Date().toISOString() }).eq('id', ishaanId).select();
    check("can't update someone else's activity_read_at", denied(error, data), how(error, data));
  }

  if (cleanupTokens.length) await admin.from('push_tokens').delete().in('id', cleanupTokens);
  if (cleanupMessages.length) await admin.from('dm_messages').delete().in('id', cleanupMessages);
  console.log(failed === 0 ? '\nAll notification-RLS checks passed.\n' : `\n${failed} failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
