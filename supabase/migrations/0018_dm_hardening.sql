-- =============================================================================
-- 0018_dm_hardening.sql
--
-- Fixes found in a deep review of the DM subsystem after 0014 introduced
-- `thread_with_id` as a thread's real identity. Several sibling pieces
-- (RLS, the unread count) were never updated to match it, and one Realtime
-- gap made messages themselves feel non-live even though the typing
-- indicator (a separate broadcast channel) already was.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- drake_id() -- same shape as ishaan_id() (0008_dm.sql), for the RLS below.
-- -----------------------------------------------------------------------------
create or replace function public.drake_id()
returns uuid
language sql
stable
as $$
  select id from public.profiles where username = 'prosecco_daddy' limit 1;
$$;

-- -----------------------------------------------------------------------------
-- thread_with_id's FK was added (0014) without ON DELETE CASCADE, unlike
-- every other FK on this table -- deleting the ishaan or Drake account would
-- hard-fail on a foreign_key_violation instead of cascading like the rest of
-- the row's relationships do.
-- -----------------------------------------------------------------------------
alter table public.dm_messages drop constraint if exists dm_messages_thread_with_id_fkey;
alter table public.dm_messages
  add constraint dm_messages_thread_with_id_fkey
  foreign key (thread_with_id) references public.profiles (id) on delete cascade;

-- -----------------------------------------------------------------------------
-- dm_messages_select: ishaan's branch was unconditional ("auth.uid() =
-- ishaan_id()" matches every row), so he could SELECT threads he has no
-- screen that can ever open (e.g. a Drake DM to a regular user). Scope his
-- visibility to threads actually addressed to him, matching dm_inbox()'s own
-- scoping since 0014.
-- -----------------------------------------------------------------------------
drop policy if exists dm_messages_select on public.dm_messages;
create policy dm_messages_select
  on public.dm_messages for select
  to authenticated
  using (
    thread_user_id = (select auth.uid())
    or (
      (select auth.uid()) = public.ishaan_id()
      and thread_with_id = public.ishaan_id()
    )
  );

-- -----------------------------------------------------------------------------
-- dm_messages_insert: never updated after 0014 introduced thread_with_id, so
-- nothing enforced the "small set of accounts allowed to write into someone
-- else's thread" the migration's own comment describes -- a regular user
-- could insert with thread_with_id pointing at an arbitrary profile. Now: a
-- regular user may only write into their own thread_user_id bucket, and only
-- with ishaan or Drake as thread_with_id; ishaan may reply into anyone's
-- thread_user_id, but only ever as thread_with_id = himself, matching how
-- his inbox is scoped. (The Drake bot itself writes via the drake-dm Edge
-- Function's service-role client, which bypasses RLS entirely.)
-- -----------------------------------------------------------------------------
drop policy if exists dm_messages_insert on public.dm_messages;
create policy dm_messages_insert
  on public.dm_messages for insert
  to authenticated
  with check (
    sender_id = (select auth.uid())
    and (
      (
        thread_user_id = (select auth.uid())
        and thread_with_id in (public.ishaan_id(), public.drake_id())
      )
      or (
        (select auth.uid()) = public.ishaan_id()
        and thread_with_id = public.ishaan_id()
      )
    )
  );

-- -----------------------------------------------------------------------------
-- dm_messages_update_read (0009): same unconditional ishaan branch as the
-- select policy let him mark read_at on a thread he's not actually in.
-- -----------------------------------------------------------------------------
drop policy if exists dm_messages_update_read on public.dm_messages;
create policy dm_messages_update_read
  on public.dm_messages for update
  to authenticated
  using (
    sender_id <> (select auth.uid())
    and (
      thread_user_id = (select auth.uid())
      or (
        (select auth.uid()) = public.ishaan_id()
        and thread_with_id = public.ishaan_id()
      )
    )
  )
  with check (
    sender_id <> (select auth.uid())
    and (
      thread_user_id = (select auth.uid())
      or (
        (select auth.uid()) = public.ishaan_id()
        and thread_with_id = public.ishaan_id()
      )
    )
  );

-- -----------------------------------------------------------------------------
-- my_dm_thread_previews() -- the latest message per thread_with_id for the
-- caller's own threads. Replaces useMyDMThreads() fetching a user's entire
-- message history client-side just to keep two preview lines; mirrors
-- dm_inbox()'s own `distinct on` shape.
-- -----------------------------------------------------------------------------
drop function if exists public.my_dm_thread_previews();
create function public.my_dm_thread_previews()
returns table (
  thread_with_id  uuid,
  last_body       text,
  last_sender_id  uuid,
  last_created_at timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select distinct on (thread_with_id)
    thread_with_id, body, sender_id, created_at
  from public.dm_messages
  where thread_user_id = (select auth.uid())
  order by thread_with_id, created_at desc;
$$;

revoke all on function public.my_dm_thread_previews() from public;
grant execute on function public.my_dm_thread_previews() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Realtime: dm_messages was never added to the supabase_realtime publication,
-- so useDMThread() had no way to learn about a new message except leaving
-- and re-entering the screen (the typing indicator worked live because it's
-- a broadcast channel, not a postgres_changes subscription, so it never
-- needed this). Guarded so re-running this file is safe either way.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'dm_messages'
  ) then
    alter publication supabase_realtime add table public.dm_messages;
  end if;
end $$;
