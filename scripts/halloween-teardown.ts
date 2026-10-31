/**
 * Backs out Halloween 2026: the group chat and every photo posted for it.
 *
 *   npx tsx scripts/halloween-teardown.ts             # dry run, deletes nothing
 *   npx tsx scripts/halloween-teardown.ts --execute   # does it
 *   npx tsx scripts/halloween-teardown.ts --execute --all-today
 *
 * Deletes, in order:
 *   1. Post rows with filter_name = 'Samhain' (likes, comments, tags cascade),
 *      then their files in the `photos` bucket. Samhain was the only postable
 *      filter on the day, so this is "every photo posted for Halloween".
 *      --all-today widens it to every post created since TODAY_START_UTC,
 *      including any made on an old build that ignored the filter lock.
 *   2. group_chat_messages (group_chat_senders cascades), then
 *      group_chat_aliases.
 *   3. Every object in the `halloween-chat` bucket, then the bucket itself.
 *
 * Idempotent: a second run finds nothing and exits clean. Service-role key
 * from .env -- server side only.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const TODAY_START_UTC = '2026-10-31T06:00:00Z'; // local midnight in MDT
const CHAT_BUCKET = 'halloween-chat';
const execute = process.argv.includes('--execute');
const allToday = process.argv.includes('--all-today');

for (const f of ['.env', '.env.local']) {
  try {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function listChatObjects(): Promise<string[]> {
  const names: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.storage.from(CHAT_BUCKET).list('', { limit: 1000, offset });
    if (error) {
      if (/not found/i.test(error.message)) return names;
      throw error;
    }
    names.push(...data.filter((o) => o.id).map((o) => o.name));
    if (data.length < 1000) return names;
  }
}

async function count(table: string): Promise<number> {
  const { count: n, error } = await db.from(table).select('*', { count: 'exact', head: true });
  if (error) throw error;
  return n ?? 0;
}

async function main() {
  const base = db.from('posts').select('id, image_path, filter_name, created_at');
  const { data: posts, error } = allToday
    ? await base.gte('created_at', TODAY_START_UTC)
    : await base.eq('filter_name', 'Samhain');
  if (error) throw error;

  const { data: others } = await db
    .from('posts')
    .select('id')
    .gte('created_at', TODAY_START_UTC)
    .or('filter_name.is.null,filter_name.neq.Samhain');
  const chatFiles = await listChatObjects();
  const msgs = await count('group_chat_messages');
  const aliases = await count('group_chat_aliases');

  console.log(execute ? 'EXECUTE' : 'DRY RUN (pass --execute to delete)');
  console.log(`posts to delete:         ${posts!.length}${allToday ? ` (all since ${TODAY_START_UTC})` : ' (filter Samhain)'}`);
  console.log(`other posts same day:    ${others?.length ?? 0}${allToday ? ' -- included above' : ' -- left alone (--all-today to include)'}`);
  console.log(`chat messages:           ${msgs}`);
  console.log(`chat aliases:            ${aliases}`);
  console.log(`chat bucket objects:     ${chatFiles.length}`);
  if (!execute) return;

  const ids = posts!.map((p) => p.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { error: e } = await db.from('posts').delete().in('id', ids.slice(i, i + 100));
    if (e) throw e;
  }
  const paths = posts!.map((p) => p.image_path);
  for (let i = 0; i < paths.length; i += 100) {
    const { error: e } = await db.storage.from('photos').remove(paths.slice(i, i + 100));
    if (e) throw e;
  }

  const nil = '00000000-0000-0000-0000-000000000000';
  const { error: e1 } = await db.from('group_chat_messages').delete().neq('id', nil);
  if (e1) throw e1;
  const { error: e2 } = await db.from('group_chat_aliases').delete().neq('user_id', nil);
  if (e2) throw e2;

  for (let i = 0; i < chatFiles.length; i += 100) {
    const { error: e } = await db.storage.from(CHAT_BUCKET).remove(chatFiles.slice(i, i + 100));
    if (e) throw e;
  }
  const { error: eb } = await db.storage.deleteBucket(CHAT_BUCKET);
  if (eb && !/not found/i.test(eb.message)) throw eb;

  console.log('done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
