// Supabase Edge Function: drake-dm
//
// Called every 4 hours by a pg_cron schedule (see 0013_drake_dm.sql). Sends
// one DM as @prosecco_daddy to a random real account. Uses the service-role
// client, so this bypasses dm_messages' normal RLS entirely (see
// 0008_dm.sql: ordinarily only `ishaan` can write into someone else's
// thread) -- this is the one place in the app that's allowed to.
//
// Deploy via Dashboard -> Edge Functions -> New Function (paste this file),
// name it exactly `drake-dm`. Turn off "Enforce JWT verification" the same
// way as daily-drake -- pg_cron calls it with no user JWT to verify.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(supabaseUrl, serviceRoleKey);

const BOT_USERNAME = 'prosecco_daddy';

const MESSAGES = [
  'hey. you up?',
  "started from the bottom, now I'm just texting you",
  "no new friends, but I'm making an exception for you",
  "views from the 6, DMs from the bot account",
  "I'm way too good to you, and yet here I am",
  'in my feelings again. this time about you not responding',
  'certified lover boy behavior: sliding into DMs on a random Tuesday',
  "0 to 100 real quick, mostly because I have nothing else going on",
  'worst behavior, best intentions',
  "one dance? no, just this text, but I'll take it",
  "still not the type to give up so soon on this DM landing",
  "if I text 'hey' does that count as us talking now",
  "know yourself, know your worth, know that I'm a little bored right now",
  'hotline bling, except it’s just this app pinging you at a weird hour',
  "runnin' through the 6 with my woes -- you're not a woe, you're just next on the list",
  "energy, I don't chase. except right now, chasing this conversation a little",
  'prosecco o’clock somewhere, and I was thinking about you specifically',
  "you the one. or at least, the random() function said so",
  'take care -- actual advice, also the name of an album, you should stream it',
  "passionfruit summer, but it's a random weekday and I'm still thinking of you",
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

Deno.serve(async () => {
  const { data: bot, error: botErr } = await db
    .from('profiles')
    .select('id')
    .eq('username', BOT_USERNAME)
    .single();
  if (botErr || !bot) {
    console.error('bot account not found', botErr);
    return new Response('bot not found', { status: 200 });
  }

  // ishaan sees every thread via his own inbox (dm_inbox(), 0008_dm.sql)
  // regardless of who the target is, so excluding him from being a target
  // himself just avoids the "thread with yourself" oddity of a message
  // landing in thread_user_id = his own id -- he still sees every Drake DM
  // that goes out either way.
  const { data: ishaan } = await db.from('profiles').select('id').eq('username', 'ishaan').single();
  const excluded = [bot.id, ishaan?.id].filter(Boolean) as string[];

  const { data: candidates, error: candidatesErr } = await db
    .from('profiles')
    .select('id')
    .not('id', 'in', `(${excluded.join(',')})`);
  if (candidatesErr || !candidates || candidates.length === 0) {
    console.error('no DM candidates found', candidatesErr);
    return new Response('no candidates', { status: 200 });
  }

  const recipient = pickRandom(candidates);
  const body = pickRandom(MESSAGES);

  const { error: insertErr } = await db.from('dm_messages').insert({
    thread_user_id: recipient.id,
    // Without this, it defaults to ishaan's thread (0014_dm_multi_thread.sql)
    // and the message lands mixed into the recipient's conversation with
    // ishaan instead of being its own separate thread with Drake.
    thread_with_id: bot.id,
    sender_id: bot.id,
    body,
  });
  if (insertErr) {
    console.error('DM insert failed', insertErr);
    return new Response('insert failed', { status: 502 });
  }

  return new Response('sent', { status: 200 });
});
