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
    .select('id, post_id, body')
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
  for (const row of due) {
    const { error: insertErr } = await db.from('comments').insert({
      post_id: row.post_id,
      author_id: bot.id,
      body: row.body,
    });
    if (insertErr) {
      // Leave it queued -- next minute's run retries it rather than losing it.
      console.error(`post failed for pending reply ${row.id}`, insertErr);
      continue;
    }
    const { error: deleteErr } = await db.from('drake_pending_comment_replies').delete().eq('id', row.id);
    if (deleteErr) {
      // Posted but not cleared -- worst case it's posted again next run,
      // which is a better failure mode than silently dropping it.
      console.error(`could not clear sent reply ${row.id}`, deleteErr);
    }
    sent++;
  }

  return new Response(`sent ${sent}/${due.length}`, { status: 200 });
});
