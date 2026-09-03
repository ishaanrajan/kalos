/**
 * 0010_onboarding.sql: a brand-new signup must get onboarded = false from
 * handle_new_user() itself, while every account that already existed must be
 * left at the default true -- that split is the entire point of the feature
 * ("only new users get forced through this"), so it's the one thing worth
 * asserting against the real database rather than just reading the SQL.
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
const anon = createClient(url, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });

let failed = 0;
const check = (label: string, pass: boolean, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? `  -- ${detail}` : ''}`);
};

async function main() {
  console.log('\nExisting accounts are untouched\n');
  {
    const { data, error } = await admin.from('profiles').select('username, onboarded').eq('username', 'maya.dev').single();
    check("a pre-existing seeded account is onboarded = true", !error && data?.onboarded === true, JSON.stringify(data));
  }

  console.log('\nA brand-new signup starts forced\n');
  const email = `onboarding-check-${Date.now()}@example.com`;
  const username = `onboardingcheck${Date.now()}`;
  const { data: signUp, error: signUpErr } = await anon.auth.signUp({
    email,
    password: 'testpass123',
    options: { data: { username } },
  });
  if (signUpErr) throw signUpErr;
  const userId = signUp.user!.id;

  {
    const { data, error } = await admin.from('profiles').select('onboarded, avatar_path, post_count').eq('id', userId).single();
    check('new profile row has onboarded = false', !error && data?.onboarded === false, JSON.stringify(data));
    check('new profile row starts with no avatar', data?.avatar_path === null, `avatar_path=${data?.avatar_path}`);
    check('new profile row starts with zero posts', data?.post_count === 0, `post_count=${data?.post_count}`);
  }
  {
    // Same client the app uses: can the new user flip their own flag once
    // they've actually finished onboarding (what app/(tabs)/new.tsx does)?
    const { data, error } = await anon.from('profiles').update({ onboarded: true }).eq('id', userId).select();
    check('the new user can mark their own onboarding complete', !error && !!data?.length, error?.message ?? '');
  }

  await admin.auth.admin.deleteUser(userId);
  console.log('(throwaway test account cleaned up)');

  console.log(failed === 0 ? '\nAll onboarding checks passed.\n' : `\n${failed} failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
