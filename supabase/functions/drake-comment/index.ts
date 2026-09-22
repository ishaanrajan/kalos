// Supabase Edge Function: drake-comment
//
// Called every hour by a pg_cron schedule (see 0026_drake_comments.sql).
// Drops one canned one-liner as @prosecco_daddy on a random real post he
// hasn't already commented on, made earlier today.
//
// It also drains the @mention reply queue first, every tick, by calling
// drake-comment-reply-flush over HTTP. That function's own per-minute cron
// job has silently deregistered itself twice (0030, 0040) while this hourly
// job kept firing normally both times -- so this is the fallback that turns
// "replies never arrive until someone notices" into "replies arrive within
// the hour". The per-minute job stays; this is belt-and-suspenders, not a
// replacement. An HTTP call rather than a copy of the flush loop because
// these functions deploy independently with no shared imports, and two
// copies of the claim/stale/never-twice logic would drift.
//
// "Sporadic" is handled here, not in the schedule: an hourly tick that always
// fires would read as clockwork the moment anyone noticed the pattern (drake-dm
// already ticks every 4 hours on a fixed clock, and this deliberately isn't
// meant to feel like a second one of those). COMMENT_CHANCE below is what
// actually makes it sporadic -- most hourly ticks do nothing, and the one
// that doesn't lands at no predictable offset. MAX_DAILY_COMMENTS is a hard
// ceiling on top of that, not just a statistical tendency: once the first
// coin flip of the day lands, every later hour's flip that day is a no-op
// regardless of how it comes up.
//
// Deploy via Dashboard -> Edge Functions -> New Function (paste this file),
// name it exactly `drake-comment`. Turn off "Enforce JWT verification" --
// pg_cron calls it with no user JWT to verify, same as the other cron jobs.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(supabaseUrl, serviceRoleKey);

const BOT_USERNAME = 'prosecco_daddy';

// See the header for why this, not the schedule, is what makes this
// "sporadic," and how it interacts with MAX_DAILY_COMMENTS below.
const COMMENT_CHANCE = 0.12;

// A hard ceiling, not just a statistical tendency -- see the header.
const MAX_DAILY_COMMENTS = 1;

/** Start of the current UTC day, as an ISO string -- posts and prior
 *  comments are both compared against this, not calendar-local time, same
 *  as every other cron job in this app runs on a fixed UTC clock. */
function startOfTodayUTC(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

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

// See the header. Never lets a flush failure block the sporadic comment --
// the two are independent, and the per-minute cron is still the primary
// path for the queue.
async function flushPendingReplies(): Promise<void> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/drake-comment-reply-flush`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceRoleKey}` },
    });
    console.log(`reply flush fallback: ${res.status} ${await res.text()}`);
  } catch (e) {
    console.error('reply flush fallback failed', e);
  }
}

Deno.serve(async () => {
  await flushPendingReplies();

  const { data: bot, error: botErr } = await db
    .from('profiles')
    .select('id')
    .eq('username', BOT_USERNAME)
    .single();
  if (botErr || !bot) {
    console.error('bot account not found', botErr);
    return new Response('bot not found', { status: 200 });
  }

  const todayStart = startOfTodayUTC();

  // The ceiling check runs before the coin flip, and before even looking for
  // a post to comment on -- there's no point picking a target just to throw
  // the pick away.
  const { count: todaysCommentCount, error: countErr } = await db
    .from('comments')
    .select('id', { count: 'exact', head: true })
    .eq('author_id', bot.id)
    .gte('created_at', todayStart);
  if (countErr) {
    console.error('could not count today\'s comments', countErr);
    return new Response('query failed', { status: 502 });
  }
  if ((todaysCommentCount ?? 0) >= MAX_DAILY_COMMENTS) {
    return new Response('hit the daily ceiling', { status: 200 });
  }

  if (Math.random() > COMMENT_CHANCE) {
    return new Response('sat this one out', { status: 200 });
  }

  // A post is a candidate if it isn't the bot's own, was made today (not an
  // old post resurfacing a comment out of nowhere), and the bot hasn't
  // already commented on it. The last part is a NOT IN against every post
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

  // Also skip any post with an @mention reply still queued. If a one-liner
  // landed there first, drake-comment-reply-flush would then see the bot as
  // the thread's latest comment and drop the reply as "twice in a row" --
  // the human's mention would go unanswered because of a coin flip here.
  const { data: pending, error: pendingErr } = await db
    .from('drake_pending_comment_replies')
    .select('post_id');
  if (pendingErr) {
    console.error('could not read the reply queue', pendingErr);
    return new Response('query failed', { status: 502 });
  }
  for (const p of pending ?? []) excludePostIds.push(p.post_id);

  let query = db.from('posts').select('id').neq('author_id', bot.id).gte('created_at', todayStart);
  if (excludePostIds.length > 0) {
    query = query.not('id', 'in', `(${excludePostIds.join(',')})`);
  }
  const { data: candidates, error: candidatesErr } = await query;
  if (candidatesErr) {
    console.error('could not query candidate posts', candidatesErr);
    return new Response('query failed', { status: 502 });
  }
  if (!candidates || candidates.length === 0) {
    // Expected on a quiet day -- nothing posted today yet is not an error.
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
