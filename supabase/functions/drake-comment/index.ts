// Supabase Edge Function: drake-comment
//
// Called every hour by a pg_cron schedule (see 0026_drake_comments.sql).
// Drops one canned one-liner as @prosecco_daddy on a random real post he
// hasn't already commented on.
//
// "Sporadic" is handled here, not in the schedule: an hourly tick that always
// fires would read as clockwork the moment anyone noticed the pattern (drake-dm
// already ticks every 4 hours on a fixed clock, and this deliberately isn't
// meant to feel like a second one of those). COMMENT_CHANCE below is what
// actually makes it sporadic -- most hourly ticks do nothing, and the ones
// that don't land at no predictable offset. Expected cadence works out to
// roughly one comment every ~4 hours, same ballpark as drake-dm, but never on
// its clock.
//
// Deploy via Dashboard -> Edge Functions -> New Function (paste this file),
// name it exactly `drake-comment`. Turn off "Enforce JWT verification" --
// pg_cron calls it with no user JWT to verify, same as the other cron jobs.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(supabaseUrl, serviceRoleKey);

const BOT_USERNAME = 'prosecco_daddy';

// One in four hourly ticks actually comments -- see the header for why this,
// not the schedule, is what makes this "sporadic."
const COMMENT_CHANCE = 0.25;

const COMMENTS = [
  'this might be the best post I’ve seen today, and I’ve seen a lot of posts',
  'no cap, certified banger, no notes',
  'this photo’s giving main character energy and I’m not mad about it',
  'you ever post something so good it should honestly be illegal',
  'okay we get it, you’re THAT girl/guy. anyway loved this',
  'this is the kind of post that gets you a spot in my rotation',
  'not me stopping my scroll for this. rare, actually',
  'certified lover boy behavior, dropping into your comments unannounced',
  'views from the 6, but make it your feed specifically',
  'I don’t comment on everything. this earned it though',
  'saving this one, no I will not explain why',
  'the way this photo just ended my whole scroll session',
  'okay but who let you post like this',
  'this is a 10 out of 10, prosecco included',
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

Deno.serve(async () => {
  if (Math.random() > COMMENT_CHANCE) {
    return new Response('sat this one out', { status: 200 });
  }

  const { data: bot, error: botErr } = await db
    .from('profiles')
    .select('id')
    .eq('username', BOT_USERNAME)
    .single();
  if (botErr || !bot) {
    console.error('bot account not found', botErr);
    return new Response('bot not found', { status: 200 });
  }

  // A post is a candidate if it isn't the bot's own, and the bot hasn't
  // already commented on it. The second half is a NOT IN against every post
  // the bot has ever commented on, rather than a separate "already used" log
  // table (contrast daily-drake's drake_bot_photo_log) -- the fact is already
  // a queryable row shape in public.comments, so there's nothing a second
  // table would track that this doesn't already know.
  const { data: alreadyCommented, error: commentedErr } = await db
    .from('comments')
    .select('post_id')
    .eq('author_id', bot.id);
  if (commentedErr) {
    console.error('could not read prior comments', commentedErr);
    return new Response('query failed', { status: 502 });
  }
  const excludePostIds = (alreadyCommented ?? []).map((c) => c.post_id);

  let query = db.from('posts').select('id').neq('author_id', bot.id);
  if (excludePostIds.length > 0) {
    query = query.not('id', 'in', `(${excludePostIds.join(',')})`);
  }
  const { data: candidates, error: candidatesErr } = await query;
  if (candidatesErr || !candidates || candidates.length === 0) {
    console.error('no comment candidates found', candidatesErr);
    return new Response('no candidates', { status: 200 });
  }

  const target = pickRandom(candidates);
  const body = pickRandom(COMMENTS);

  const { error: insertErr } = await db.from('comments').insert({
    post_id: target.id,
    author_id: bot.id,
    body,
  });
  if (insertErr) {
    console.error('comment insert failed', insertErr);
    return new Response('insert failed', { status: 502 });
  }

  return new Response('commented', { status: 200 });
});
