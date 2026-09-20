-- =============================================================================
-- 0037_dm_unread_bold.sql
--
-- The Messages list bolds a thread's row until it's read, the same
-- convention iMessage/Instagram both use -- previously the only unread
-- signal anywhere was the single red dot on the tab bar icon
-- (useHasUnreadDMs), which says "something's unread" but not which thread.
--
-- Both inbox RPCs gain a `has_unread` column: true when any message in
-- that thread has sender_id <> the caller and read_at is still null --
-- the exact same predicate useMarkDMRead() already clears in one update,
-- so a thread's bold state and its ability to be marked read never
-- disagree about what "unread" means. Return-column changes require drop
-- + recreate (see 0033's own note on this); both bodies below are their
-- source migration's verbatim body (0014 for dm_inbox, 0027 for
-- my_dm_thread_previews) plus the one new column.
-- =============================================================================

drop function if exists public.dm_inbox(int);

create function public.dm_inbox(lim int default 50)
returns table (
  thread_user_id  uuid,
  username        text,
  display_name    text,
  avatar_path     text,
  last_body       text,
  last_sender_id  uuid,
  last_created_at timestamptz,
  has_unread      boolean
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
    m.created_at,
    exists (
      select 1
      from public.dm_messages um
      where um.thread_user_id = m.thread_user_id
        and um.thread_with_id = public.ishaan_id()
        and um.sender_id <> (select auth.uid())
        and um.read_at is null
    ) as has_unread
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

drop function if exists public.my_dm_thread_previews();

create function public.my_dm_thread_previews()
returns table (
  thread_with_id  uuid,
  last_body       text,
  last_sender_id  uuid,
  last_created_at timestamptz,
  has_unread      boolean
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select distinct on (other_id)
    other_id, body, sender_id, created_at, has_unread
  from (
    select
      case when dm.thread_user_id = (select auth.uid()) then dm.thread_with_id else dm.thread_user_id end as other_id,
      dm.body, dm.sender_id, dm.created_at,
      exists (
        select 1
        from public.dm_messages um
        where um.thread_user_id = dm.thread_user_id
          and um.thread_with_id = dm.thread_with_id
          and um.sender_id <> (select auth.uid())
          and um.read_at is null
      ) as has_unread
    from public.dm_messages dm
    where dm.thread_user_id = (select auth.uid())
       or (
         dm.thread_with_id = (select auth.uid())
         and public.dm_peer_allowed(dm.thread_user_id, dm.thread_with_id)
       )
  ) t
  order by other_id, created_at desc;
$$;

revoke all on function public.dm_inbox(int) from public;
revoke all on function public.my_dm_thread_previews() from public;

grant execute on function public.dm_inbox(int) to authenticated, service_role;
grant execute on function public.my_dm_thread_previews() to authenticated, service_role;
