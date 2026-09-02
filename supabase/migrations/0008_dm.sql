-- =============================================================================
-- 0008_dm.sql
--
-- Direct messages -- deliberately not a general DM system. Every user has
-- exactly one thread, and it is always with the account named "ishaan". There
-- is no conversations/pairing table because there is nothing to pair: a
-- thread's identity IS the non-ishaan participant (thread_user_id), so "one
-- thread per user" falls out of the schema for free rather than needing to be
-- enforced separately.
--
-- Messages are immutable -- no update policy, no delete policy -- and there is
-- no read-tracking. Both are real DM features intentionally left out; add them
-- later only if actually needed.
-- =============================================================================

create or replace function public.ishaan_id()
returns uuid
language sql
stable
as $$
  select id from public.profiles where username = 'ishaan' limit 1;
$$;

create table if not exists public.dm_messages (
  id             uuid primary key default gen_random_uuid(),
  -- The non-ishaan participant. This IS the thread's identity.
  thread_user_id uuid not null references public.profiles (id) on delete cascade,
  sender_id      uuid not null references public.profiles (id) on delete cascade,
  body           text not null check (length(btrim(body)) > 0 and length(body) <= 2000),
  created_at     timestamptz not null default now()
);

create index if not exists dm_messages_thread_idx
  on public.dm_messages (thread_user_id, created_at);

alter table public.dm_messages enable row level security;

drop policy if exists dm_messages_select on public.dm_messages;
create policy dm_messages_select
  on public.dm_messages for select
  to authenticated
  using (
    thread_user_id = (select auth.uid())
    or (select auth.uid()) = public.ishaan_id()
  );

drop policy if exists dm_messages_insert on public.dm_messages;
create policy dm_messages_insert
  on public.dm_messages for insert
  to authenticated
  with check (
    -- You can only ever send as yourself.
    sender_id = (select auth.uid())
    and (
      -- A regular user can only write into their own thread.
      thread_user_id = (select auth.uid())
      -- ishaan can write into anyone's thread, replying to them.
      or (select auth.uid()) = public.ishaan_id()
    )
  );

-- Migration 0007 revoked the schema's default blanket grant, so a new table
-- starts with nothing and needs its grants stated explicitly.
revoke all on public.dm_messages from anon, authenticated;
grant select, insert on public.dm_messages to authenticated;
grant all on public.dm_messages to service_role;

-- -----------------------------------------------------------------------------
-- dm_inbox(lim) -- every thread that has messaged ishaan, most recent first.
-- Meaningless (and empty) for anyone who isn't ishaan: the client only ever
-- calls this from the inbox screen, which is itself gated to ishaan's account,
-- but the function enforces it independently rather than trusting the client.
-- -----------------------------------------------------------------------------
drop function if exists public.dm_inbox(int);
create function public.dm_inbox(lim int default 50)
returns table (
  thread_user_id  uuid,
  username        text,
  display_name    text,
  avatar_path     text,
  last_body       text,
  last_sender_id  uuid,
  last_created_at timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    p.id,
    p.username::text,
    p.display_name,
    p.avatar_path,
    m.body,
    m.sender_id,
    m.created_at
  from (
    select distinct on (thread_user_id)
      thread_user_id, body, sender_id, created_at
    from public.dm_messages
    where (select auth.uid()) = public.ishaan_id()
    order by thread_user_id, created_at desc
  ) m
  join public.profiles p on p.id = m.thread_user_id
  order by m.created_at desc
  limit least(greatest(coalesce(lim, 50), 1), 100);
$$;

revoke all on function public.dm_inbox(int) from public;
grant execute on function public.dm_inbox(int) to authenticated, service_role;
