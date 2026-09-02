-- =============================================================================
-- 0009_notifications.sql
--
-- Push notifications + the read-tracking they and the in-app red dots both
-- depend on. Three independent pieces:
--   1. push_tokens        -- where a device's Expo push token lives
--   2. dm_messages.read_at -- per-message read state, recipient-writable only
--   3. profiles.activity_read_at -- one timestamp is enough for Activity,
--                                    since it's a single feed, not per-thread
--   4. Database Webhooks -- fire the notify Edge Function on the four event
--      tables. The Edge Function itself is deployed separately (Dashboard ->
--      Functions or `supabase functions deploy`), not part of this file.
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

-- -----------------------------------------------------------------------------
-- Database Webhooks -- fire-and-forget POSTs to the notify Edge Function.
-- Requires the Edge Function at .../functions/v1/notify to already be
-- deployed; these triggers will queue successfully either way, they just
-- won't have anything useful to call until it exists.
-- -----------------------------------------------------------------------------
drop trigger if exists notify_on_dm on public.dm_messages;
create trigger notify_on_dm
  after insert on public.dm_messages
  for each row
  execute function supabase_functions.http_request(
    'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/notify',
    'POST', '{"Content-type":"application/json"}', '{}', '5000'
  );

drop trigger if exists notify_on_like on public.likes;
create trigger notify_on_like
  after insert on public.likes
  for each row
  execute function supabase_functions.http_request(
    'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/notify',
    'POST', '{"Content-type":"application/json"}', '{}', '5000'
  );

drop trigger if exists notify_on_comment on public.comments;
create trigger notify_on_comment
  after insert on public.comments
  for each row
  execute function supabase_functions.http_request(
    'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/notify',
    'POST', '{"Content-type":"application/json"}', '{}', '5000'
  );

drop trigger if exists notify_on_follow on public.follows;
create trigger notify_on_follow
  after insert on public.follows
  for each row
  execute function supabase_functions.http_request(
    'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/notify',
    'POST', '{"Content-type":"application/json"}', '{}', '5000'
  );
