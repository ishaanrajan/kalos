-- =============================================================================
-- 0019_drake_reply.sql
--
-- Drake replies: when a human messages @prosecco_daddy, an Edge Function
-- (drake-reply-generate, triggered by the same Database Webhook shape as
-- notify) generates an in-character reply via the Claude API and queues it
-- here rather than sending it immediately -- a bot that replies in 40ms
-- reads as a bot. A pg_cron job (drake-reply-flush) sends whatever's due
-- once a minute.
--
-- No RLS policies on purpose: this table is an internal work queue between
-- two service-role Edge Functions, never read or written by a client.
-- =============================================================================

create table if not exists public.drake_pending_replies (
  id             uuid primary key default gen_random_uuid(),
  thread_user_id uuid not null references public.profiles (id) on delete cascade,
  body           text not null,
  created_at     timestamptz not null default now(),
  -- When this is due to actually land in dm_messages -- a random few minutes
  -- out from created_at, picked by drake-reply-generate, so the reply doesn't
  -- appear the instant the human hits send.
  send_at        timestamptz not null
);

create index if not exists drake_pending_replies_due_idx
  on public.drake_pending_replies (send_at);

alter table public.drake_pending_replies enable row level security;

revoke all on public.drake_pending_replies from anon, authenticated;
grant all on public.drake_pending_replies to service_role;

-- -----------------------------------------------------------------------------
-- pg_cron: flush due replies every minute. Same prerequisites as
-- 0011/0013_drake_*.sql -- pg_net and pg_cron should already be enabled.
-- `cron.schedule` upserts by name, so re-running this file after a tweak is
-- safe.
-- -----------------------------------------------------------------------------
select cron.schedule(
  'drake-reply-flush-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/drake-reply-flush',
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  $$
);
