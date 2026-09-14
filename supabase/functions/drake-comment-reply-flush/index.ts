// Supabase Edge Function: drake-comment-reply-flush
//
// Called every minute by a pg_cron schedule (0026_drake_comments.sql). Posts
// whatever's due out of drake_pending_comment_replies -- rows
// drake-comment-reply-generate queued with a randomized send_at, so the
// reply doesn't land the instant a human posts the comment that provoked it.
// Inserting into public.comments here (as the service role, same as
// drake-comment) reuses the existing `notify` webhook for free: whoever the
// reply is relevant to gets a real push notification when it actually posts.
//
// Deploy via Dashboard -> Edge Functions -> New Function (paste this file),
// name it exactly `drake-comment-reply-flush`. Turn off "Enforce JWT
// verification", same as the other cron-driven functions -- pg_cron calls it
// with no user JWT to attach.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(supabaseUrl, serviceRoleKey);

const BOT_USERNAME = 'prosecco_daddy';

// Upper bound per run -- plenty for a friends-and-family scale app, and caps
// how much one cron tick can do if something ever backs up the queue.
const BATCH_LIMIT = 20;

// A reply that missed its window by this much is dropped, not posted late.
// The flush cron was once silently dead for most of a day (see
// 0030_fix_drake_comment_reply_cron.sql); when it came back it drained a
// 9-hour-old backlog in one tick, including a second reply on a thread the
// human had already been answered in. A reply to "@prosecco_daddy ..." nine
// hours later reads as a bug, not a bit -- better to stay quiet.
const MAX_LATE_MS = 2 * 60 * 60 * 1000;

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

  const { data: due, error: dueErr } = await db
    .from('drake_pending_comment_replies')
    .select('id, post_id, body, send_at')
    .lte('send_at', new Date().toISOString())
    .order('send_at', { ascending: true })
    .limit(BATCH_LIMIT);
  if (dueErr) {
    console.error('could not query due replies', dueErr);
    return new Response('query failed', { status: 502 });
  }
  if (!due || due.length === 0) {
    return new Response('nothing due', { status: 200 });
  }

  let sent = 0;
  let dropped = 0;
  for (const row of due) {
    // Claim the row first. Insert-then-delete meant a failed delete posted
    // the same reply again a minute later; delete-then-insert means a failed
    // insert loses one reply. For something that auto-posts publicly under
    // his name, a missing comment is the better failure mode than a
    // duplicated one.
    const { data: claimed, error: claimErr } = await db
      .from('drake_pending_comment_replies')
      .delete()
      .eq('id', row.id)
      .select('id');
    if (claimErr || !claimed || claimed.length === 0) {
      // Already taken by an overlapping run, or gone. Either way not ours.
      continue;
    }

    if (Date.now() - new Date(row.send_at).getTime() > MAX_LATE_MS) {
      console.warn(`dropped stale reply ${row.id} for post ${row.post_id}`);
      dropped++;
      continue;
    }

    // Never twice in a row. If the last thing on the thread is already him
    // -- a sporadic one-liner, or an earlier reply to the same mention that
    // got queued twice -- a second consecutive comment with nobody in
    // between reads as him talking to himself. The mention that provoked
    // this reply has, by definition, already been answered.
    const { data: latest, error: latestErr } = await db
      .from('comments')
      .select('author_id')
      .eq('post_id', row.post_id)
      .order('created_at', { ascending: false })
      .limit(1);
    if (latestErr) {
      console.error(`could not read thread for pending reply ${row.id}`, latestErr);
      dropped++;
      continue;
    }
    if (latest?.[0]?.author_id === bot.id) {
      console.warn(`dropped reply ${row.id}: last comment on post ${row.post_id} is already the bot's`);
      dropped++;
      continue;
    }

    const { error: insertErr } = await db.from('comments').insert({
      post_id: row.post_id,
      author_id: bot.id,
      body: row.body,
    });
    if (insertErr) {
      console.error(`post failed for pending reply ${row.id}`, insertErr);
      dropped++;
      continue;
    }
    sent++;
  }

  return new Response(`sent ${sent}, dropped ${dropped}, of ${due.length}`, { status: 200 });
});
