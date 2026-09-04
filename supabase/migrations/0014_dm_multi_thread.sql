-- =============================================================================
-- 0014_dm_multi_thread.sql
--
-- Bug fix: drake-dm was writing into the same thread_user_id bucket as the
-- ishaan thread, so a user's Drake DM landed mixed into their conversation
-- with ishaan instead of being its own separate thread.
--
-- thread_user_id alone used to BE a thread's identity ("the non-ishaan
-- participant" -- see 0008_dm.sql). That assumed the *other* side was always
-- ishaan. It no longer is: a thread's real identity is now the pair
-- (thread_user_id, thread_with_id) -- which human, and which of the small
-- set of accounts allowed to write into someone else's thread (today:
-- ishaan, or the Drake bot) it's with.
--
-- Existing rows are all pre-Drake ishaan threads, so they backfill to
-- ishaan_id() for free via the column default.
-- =============================================================================

alter table public.dm_messages
  add column if not exists thread_with_id uuid not null references public.profiles (id)
  default public.ishaan_id();

create index if not exists dm_messages_thread_with_idx
  on public.dm_messages (thread_user_id, thread_with_id, created_at);

-- One-off correction: drake-dm ran at least once before this migration and
-- before it started setting thread_with_id itself, so any message it's
-- already sent backfilled to ishaan_id() along with everything else above.
-- Move those specific rows into their rightful separate thread.
update public.dm_messages
   set thread_with_id = sender_id
 where sender_id = (select id from public.profiles where username = 'prosecco_daddy');

-- dm_inbox() used to implicitly assume every row was an ishaan thread --
-- `distinct on (thread_user_id)` alone would now blend an ishaan thread and
-- a Drake thread for the same user into a single (wrong) inbox row. Scope it
-- to ishaan's own threads explicitly.
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
      and thread_with_id = public.ishaan_id()
    order by thread_user_id, created_at desc
  ) m
  join public.profiles p on p.id = m.thread_user_id
  order by m.created_at desc
  limit least(greatest(coalesce(lim, 50), 1), 100);
$$;

revoke all on function public.dm_inbox(int) from public;
grant execute on function public.dm_inbox(int) to authenticated, service_role;
