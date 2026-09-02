-- =============================================================================
-- 0009_notifications.sql
--
-- Push notifications + the read-tracking they and the in-app red dots both
-- depend on. Three independent pieces:
--   1. push_tokens        -- where a device's Expo push token lives
--   2. dm_messages.read_at -- per-message read state, recipient-writable only
--   3. profiles.activity_read_at -- one timestamp is enough for Activity,
--                                    since it's a single feed, not per-thread
--
-- The four Database Webhooks (dm_messages/likes/comments/follows -> the
-- notify Edge Function) are NOT in this file. They were originally written
-- as raw `supabase_functions.http_request` trigger SQL, but that schema only
-- exists once a project has created its first webhook -- so on a project
-- that never has, running that SQL directly fails with
-- `schema "supabase_functions" does not exist`. Simpler and more robust to
-- create them in Dashboard -> Database -> Webhooks instead: it provisions
-- that schema itself and handles the Edge Function's auth header for you.
-- See supabase/README.md for the exact steps.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- push_tokens
--
-- Written by the client (a device registering itself), read only by the
-- notify Edge Function via the service role -- no client ever needs to read
-- another row here, or even its own.
-- -----------------------------------------------------------------------------
create table if not exists public.push_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  token      text not null unique,
  platform   text not null check (platform in ('ios', 'android')),
  updated_at timestamptz not null default now()
);

create index if not exists push_tokens_user_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

drop policy if exists push_tokens_all_own on public.push_tokens;
create policy push_tokens_all_own
  on public.push_tokens for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.push_tokens from anon, authenticated;
grant select, insert, update, delete on public.push_tokens to authenticated;
grant all on public.push_tokens to service_role;

-- -----------------------------------------------------------------------------
-- dm_messages.read_at
--
-- Only the recipient of a thread may set this -- never the sender, and never
-- any column but this one. Same column-level-grant-plus-row-policy shape as
-- the counter protection in 0004/0007.
-- -----------------------------------------------------------------------------
alter table public.dm_messages add column if not exists read_at timestamptz;

drop policy if exists dm_messages_update_read on public.dm_messages;
create policy dm_messages_update_read
  on public.dm_messages for update
  to authenticated
  using (
    sender_id <> (select auth.uid())
    and (
      thread_user_id = (select auth.uid())
      or (select auth.uid()) = public.ishaan_id()
    )
  )
  with check (
    sender_id <> (select auth.uid())
    and (
      thread_user_id = (select auth.uid())
      or (select auth.uid()) = public.ishaan_id()
    )
  );

grant update (read_at) on public.dm_messages to authenticated;

-- -----------------------------------------------------------------------------
-- profiles.activity_read_at
-- -----------------------------------------------------------------------------
alter table public.profiles add column if not exists activity_read_at timestamptz;

grant update (username, display_name, bio, avatar_path, activity_read_at)
  on public.profiles to authenticated;
