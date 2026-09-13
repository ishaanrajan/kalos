/**
 * End-to-end check for 0027_dm_peer_sandbox.sql -- a sandboxed peer-to-peer
 * DM thread between two non-hub accounts. Runs against two disposable
 * throwaway accounts this script creates and tears down itself, never
 * against alex/cmcclel7 or any other real account, so it's safe to re-run
 * without touching anyone's real login or data.
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
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let failed = 0;
const check = (label: string, pass: boolean, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? `  -- ${detail}` : ''}`);
};
const denied = (error: unknown, data: unknown[] | null) => !!error || (data?.length ?? 0) === 0;
const how = (error: unknown, data: unknown[] | null) =>
  error
    ? `blocked (${(error as any).code ?? (error as any).message})`
    : (data?.length ?? 0) === 0
      ? 'no rows matched the policy'
      : `${data!.length} row(s) WRITTEN`;

const stamp = Date.now();
const EMAIL_A = `dm-peer-test-a-${stamp}@example.com`;
const EMAIL_B = `dm-peer-test-b-${stamp}@example.com`;
const PASSWORD = 'kalos2015-verify';

async function main() {
  const clientA = createClient(url, anonKey, { auth: { persistSession: false } });
  const clientB = createClient(url, anonKey, { auth: { persistSession: false } });

  const { data: signA, error: signAErr } = await clientA.auth.signUp({ email: EMAIL_A, password: PASSWORD });
  if (signAErr || !signA.user) throw new Error(`signup A failed: ${signAErr?.message}`);
  const { data: signB, error: signBErr } = await clientB.auth.signUp({ email: EMAIL_B, password: PASSWORD });
  if (signBErr || !signB.user) throw new Error(`signup B failed: ${signBErr?.message}`);

  const idA = signA.user.id;
  const idB = signB.user.id;
  // `lo`/`hi` name the two throwaway accounts by uuid order, matching how
  // 0027 canonicalizes a peer thread -- not who signed up first.
  const [lo, hi] = idA < idB ? [idA, idB] : [idB, idA];
  const [clientLo, clientHi] = idA < idB ? [clientA, clientB] : [clientB, clientA];

  try {
    console.log('\nBefore the pair exists in dm_peer_pairs\n');
    {
      const { data, error } = await clientLo
        .from('dm_messages')
        .insert({ thread_user_id: lo, thread_with_id: hi, sender_id: lo, body: 'verify: not yet paired' })
        .select();
      check('blocked before the pair is allowlisted', denied(error, data), how(error, data));
    }

    const { error: pairErr } = await admin.from('dm_peer_pairs').insert({ user_a: lo, user_b: hi });
    if (pairErr) throw new Error(`seeding dm_peer_pairs failed: ${pairErr.message}`);

    console.log('\nOnce paired\n');
    let msgId: string | undefined;
    {
      const { data, error } = await clientLo
        .from('dm_messages')
        .insert({ thread_user_id: lo, thread_with_id: hi, sender_id: lo, body: 'verify: lo -> hi' })
        .select();
      check('lower-id side can send into the canonical thread', !error && !!data?.length, error?.message ?? '');
      msgId = data?.[0]?.id;
    }
    {
      const { data, error } = await clientHi
        .from('dm_messages')
        .insert({ thread_user_id: lo, thread_with_id: hi, sender_id: hi, body: 'verify: hi -> lo' })
        .select();
      check('higher-id side can reply into the same thread', !error && !!data?.length, error?.message ?? '');
    }
    {
      const { data, error } = await clientHi
        .from('dm_messages')
        .select('*')
        .eq('thread_user_id', lo)
        .eq('thread_with_id', hi);
      check('higher-id side can read the whole thread', !error && (data?.length ?? 0) === 2, `${data?.length ?? 0} row(s)`);
    }
    {
      const { data, error } = await clientLo
        .from('dm_messages')
        .insert({ thread_user_id: hi, thread_with_id: lo, sender_id: lo, body: 'verify: reversed order' })
        .select();
      check('reversed (thread_user_id, thread_with_id) order is refused', denied(error, data), how(error, data));
    }
    if (msgId) {
      const { data, error } = await clientHi
        .from('dm_messages')
        .update({ read_at: new Date().toISOString() })
        .eq('id', msgId)
        .select();
      check('recipient can mark the message read', !error && !!data?.length, error?.message ?? '');
    }
    {
      const { data, error } = await clientHi.rpc('my_dm_thread_previews');
      const row = (data ?? []).find((r: { thread_with_id: string }) => r.thread_with_id === lo);
      check(
        "my_dm_thread_previews() surfaces the thread for the higher-id side too",
        !error && !!row,
        error?.message ?? (row ? 'found' : 'not found'),
      );
    }
    {
      const { data, error } = await clientHi.rpc('my_dm_peers');
      const row = (data ?? []).find((r: { id: string }) => r.id === lo);
      check('my_dm_peers() lists the other side', !error && !!row, error?.message ?? (row ? 'found' : 'not found'));
    }
  } finally {
    await admin.from('dm_peer_pairs').delete().eq('user_a', lo).eq('user_b', hi);
    await admin
      .from('dm_messages')
      .delete()
      .or(`and(thread_user_id.eq.${lo},thread_with_id.eq.${hi}),and(thread_user_id.eq.${hi},thread_with_id.eq.${lo})`);
    await admin.auth.admin.deleteUser(idA);
    await admin.auth.admin.deleteUser(idB);
  }

  console.log(failed === 0 ? '\nAll DM peer-sandbox checks passed.\n' : `\n${failed} failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
