-- =============================================================================
-- 0023_dm_message_likes.sql
--
-- Instagram-style "heart a message" reaction in DMs. Unlike read_at, either
-- thread participant can like ANY message (including their own), so the
-- row-level policy for it can't just be a stricter version of
-- dm_messages_update_read -- it needs to be *laxer* (no sender exclusion).
--
-- That matters because Postgres OR-composes multiple permissive policies
-- for the same command at the ROW level, independent of which column a
-- statement actually touches. Adding a second, laxer permissive UPDATE
-- policy alongside dm_messages_update_read would have silently reopened
-- read_at to the sender too (any statement need only satisfy ONE permissive
-- policy to touch the row; column grants alone don't carry that invariant).
-- So instead: one unified policy that only checks thread membership, and a
-- trigger that enforces the column-specific rules RLS can't express --
-- "can't fake your own read receipt", "can't set someone else's id as the
-- liker", "can't overwrite/remove another thread member's existing like".
-- =============================================================================

alter table public.dm_messages
  add column if not exists liked_by uuid references public.profiles (id) on delete set null;

drop policy if exists dm_messages_update_read on public.dm_messages;
drop policy if exists dm_messages_update on public.dm_messages;
create policy dm_messages_update
  on public.dm_messages for update
  to authenticated
  using (
    thread_user_id = (select auth.uid())
    or (
      (select auth.uid()) = public.ishaan_id()
      and thread_with_id = public.ishaan_id()
    )
  )
  with check (
    thread_user_id = (select auth.uid())
    or (
      (select auth.uid()) = public.ishaan_id()
      and thread_with_id = public.ishaan_id()
    )
  );

grant update (liked_by) on public.dm_messages to authenticated;

create or replace function public.tg_dm_messages_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.read_at is distinct from old.read_at and old.sender_id = auth.uid() then
    raise exception 'cannot mark your own message as read';
  end if;

  if new.liked_by is distinct from old.liked_by then
    if new.liked_by is not null and new.liked_by <> auth.uid() then
      raise exception 'cannot set liked_by to someone else';
    end if;
    if old.liked_by is not null and old.liked_by <> auth.uid() then
      raise exception 'message already liked by someone else';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists dm_messages_guard_update on public.dm_messages;
create trigger dm_messages_guard_update
  before update on public.dm_messages
  for each row
  execute function public.tg_dm_messages_guard_update();
