-- =============================================================================
-- 0026_drake_comments.sql
--
-- Two new Drake bot behaviors, both mirroring the DM versions this app
-- already has (0011/0013 daily-drake, 0019 drake-reply):
--
--  1. Sporadic comments: an Edge Function (drake-comment) picks a random real
--     post @prosecco_daddy hasn't already commented on and drops a canned
--     one-liner. No new table for "already commented" -- unlike
--     drake_bot_photo_log, that fact is already a queryable row shape
--     (public.comments itself), so the picker just excludes posts with an
--     existing comment from the bot rather than needing a second table.
--
--  2. @mention replies: when a human @mentions the bot in a comment, an
--     Edge Function (drake-comment-reply-generate, DB-webhook-triggered same
--     as drake-reply-generate) generates an in-character reply via Claude and
--     queues it here rather than sending it immediately, same reasoning as
--     drake_pending_replies -- an instant reply reads as a bot. A pg_cron job
--     (drake-comment-reply-flush) sends whatever's due once a minute, by
--     inserting into public.comments -- which is exactly what the existing
--     `notify` webhook already listens to, so the person who got replied to
--     gets a push for free, no new notification plumbing needed.
--
-- No RLS policies on the queue table, same as drake_pending_replies: it's an
-- internal handoff between two service-role Edge Functions, never read or
-- written by a client.
-- =============================================================================

create table if not exists public.drake_pending_comment_replies (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts (id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now(),
  -- Same idea as drake_pending_replies.send_at: a random few minutes out
  -- from created_at, so the reply doesn't appear the instant the human posts
  -- their comment.
  send_at    timestamptz not null
);

create index if not exists drake_pending_comment_replies_due_idx
  on public.drake_pending_comment_replies (send_at);

alter table public.drake_pending_comment_replies enable row level security;

revoke all on public.drake_pending_comment_replies from anon, authenticated;
grant all on public.drake_pending_comment_replies to service_role;

-- -----------------------------------------------------------------------------
-- pg_cron: flush due comment replies every minute, same cadence as
-- drake-reply-flush.
-- -----------------------------------------------------------------------------
select cron.schedule(
  'drake-comment-reply-flush-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/drake-comment-reply-flush',
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  $$
);

-- -----------------------------------------------------------------------------
-- pg_cron: check in on posting a sporadic comment once an hour. "Sporadic"
-- is drake-comment's own job, not this schedule's -- see that function's
-- header for why an hourly tick with a coin flip inside beats a longer fixed
-- interval for actually reading as sporadic rather than clockwork.
-- -----------------------------------------------------------------------------
select cron.schedule(
  'drake-comment-hourly-check',
  '0 * * * *',
  $$
  select net.http_post(
    url := 'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/drake-comment',
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  $$
);
