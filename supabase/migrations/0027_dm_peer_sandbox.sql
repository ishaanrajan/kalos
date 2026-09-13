-- =============================================================================
-- 0027_dm_peer_sandbox.sql
--
-- First step towards general peer-to-peer DMs. Until now the only accounts
-- allowed as `thread_with_id` were the two hubs, ishaan and the Drake bot
-- (0008_dm.sql, 0014_dm_multi_thread.sql) -- every regular user's thread was
-- with one of them, never with each other.
--
-- Sandboxed via an explicit allowlist table rather than opening peer DMs to
-- every account at once: dm_peer_pairs starts with exactly one pair, both
-- owned by ishaan for testing (alex <-> cmcclel7). More pairs can be added
-- later with a plain insert -- no further RLS changes needed.
--
-- A peer thread's identity is still the pair (thread_user_id, thread_with_id),
-- same as every other thread, but for a peer pair neither side is a fixed
-- hub -- so the two ids are canonicalized by uuid order (thread_user_id is
-- always the smaller id) instead of "whoever isn't the hub." Both
-- participants read and write into that one canonical row, unlike the
-- ishaan/Drake case where only the hub writes into someone else's bucket.
-- =============================================================================

create table if not exists public.dm_peer_pairs (
  user_a     uuid not null references public.profiles (id) on delete cascade,
  user_b     uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint dm_peer_pairs_ordered check (user_a < user_b),
  primary key (user_a, user_b)
);

revoke all on public.dm_peer_pairs from anon, authenticated;
grant select on public.dm_peer_pairs to authenticated;
grant all on public.dm_peer_pairs to service_role;

insert into public.dm_peer_pairs (user_a, user_b)
select least(a.id, b.id), greatest(a.id, b.id)
from public.profiles a, public.profiles b
where a.username = 'alex' and b.username = 'cmcclel7'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- dm_peer_allowed(a, b) -- true if a and b are a sandboxed peer pair, order
-- independent.
-- -----------------------------------------------------------------------------
create or replace function public.dm_peer_allowed(a uuid, b uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.dm_peer_pairs
    where user_a = least(a, b) and user_b = greatest(a, b)
  );
$$;

-- -----------------------------------------------------------------------------
-- dm_messages_select: add a branch for the "other" side of a peer thread --
-- the existing thread_user_id = auth.uid() branch already covers whichever
-- participant happens to hold the smaller id.
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
    or (
      thread_with_id = (select auth.uid())
      and public.dm_peer_allowed(thread_user_id, thread_with_id)
    )
  );

-- -----------------------------------------------------------------------------
-- dm_messages_insert: a sandboxed peer may write into the canonical thread
-- for their pair, as either sender -- there's no hub here, so unlike the
-- ishaan/Drake branch there's no separate "reply into someone else's bucket"
-- case. `thread_user_id < thread_with_id` forces every insert to use the
-- same canonical ordering dm_peer_pairs stores, so both participants always
-- land in the one shared row instead of two mirrored ones.
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
      or (
        (select auth.uid()) in (thread_user_id, thread_with_id)
        and thread_user_id < thread_with_id
        and public.dm_peer_allowed(thread_user_id, thread_with_id)
      )
    )
  );

-- -----------------------------------------------------------------------------
-- dm_messages_update_read: same peer branch as select, for marking the other
-- side's messages read.
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
      or (
        thread_with_id = (select auth.uid())
        and public.dm_peer_allowed(thread_user_id, thread_with_id)
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
      or (
        thread_with_id = (select auth.uid())
        and public.dm_peer_allowed(thread_user_id, thread_with_id)
      )
    )
  );

-- -----------------------------------------------------------------------------
-- my_dm_thread_previews(): broadened to also pick up peer threads where the
-- caller is thread_with_id, not just thread_user_id -- gated on
-- dm_peer_allowed() so this doesn't hand ishaan a preview row for every
-- user's thread with him (thread_with_id = ishaan_id() for all of those, but
-- dm_peer_allowed() is false since ishaan isn't in dm_peer_pairs).
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
  select distinct on (other_id)
    other_id, body, sender_id, created_at
  from (
    select
      case when thread_user_id = (select auth.uid()) then thread_with_id else thread_user_id end as other_id,
      body, sender_id, created_at
    from public.dm_messages
    where thread_user_id = (select auth.uid())
       or (
         thread_with_id = (select auth.uid())
         and public.dm_peer_allowed(thread_user_id, thread_with_id)
       )
  ) t
  order by other_id, created_at desc;
$$;

revoke all on function public.my_dm_thread_previews() from public;
grant execute on function public.my_dm_thread_previews() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- my_dm_peers() -- the profiles the caller is sandboxed to peer-DM, so the
-- inbox screen can render a row even before any message has been sent (the
-- same way it already does for ishaan and the bot, which come from fixed
-- useProfile() lookups rather than a message history).
-- -----------------------------------------------------------------------------
create or replace function public.my_dm_peers()
returns table (id uuid, username text, display_name text, avatar_path text)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select p.id, p.username::text, p.display_name, p.avatar_path
  from public.dm_peer_pairs pp
  join public.profiles p
    on p.id = case when pp.user_a = (select auth.uid()) then pp.user_b else pp.user_a end
  where pp.user_a = (select auth.uid()) or pp.user_b = (select auth.uid());
$$;

revoke all on function public.my_dm_peers() from public;
grant execute on function public.my_dm_peers() to authenticated, service_role;
