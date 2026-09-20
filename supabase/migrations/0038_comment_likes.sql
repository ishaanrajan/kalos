-- =============================================================================
-- 0038_comment_likes.sql
--
-- A heart on an individual comment, separate from liking the post itself --
-- 2015 Instagram had this too, once comment-liking shipped mid-2014. Same
-- shape as posts.like_count/public.likes (0002/0003): a join table plus a
-- denormalised counter column, kept correct by a trigger rather than trusted
-- from the client. There's no self-like restriction, matching public.likes,
-- which has never had one either.
-- =============================================================================

alter table public.comments add column if not exists like_count int not null default 0;

create table if not exists public.comment_likes (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  comment_id uuid not null references public.comments (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, comment_id)
);

create index if not exists comment_likes_comment_idx on public.comment_likes (comment_id);
create index if not exists comment_likes_user_idx on public.comment_likes (user_id);

-- -----------------------------------------------------------------------------
-- comments.like_count
-- -----------------------------------------------------------------------------
create or replace function public.tg_comment_likes_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.comments set like_count = like_count + 1 where id = new.comment_id;
  elsif tg_op = 'DELETE' then
    -- No-op when the parent comment is being cascade-deleted; that is fine.
    update public.comments set like_count = greatest(like_count - 1, 0) where id = old.comment_id;
  end if;
  return null;
end;
$$;

drop trigger if exists comment_likes_counts_aiud on public.comment_likes;
create trigger comment_likes_counts_aiud
  after insert or delete on public.comment_likes
  for each row execute function public.tg_comment_likes_counts();

-- -----------------------------------------------------------------------------
-- Grants + RLS. 0007 revoked the default privileges for new tables, so
-- these have to be spelled out. like_count is trigger-maintained -- no
-- update grant on comments for it, same as comments.comment_count and
-- posts.like_count.
-- -----------------------------------------------------------------------------
alter table public.comment_likes enable row level security;
revoke all on public.comment_likes from anon, authenticated;
grant select, insert, delete on public.comment_likes to authenticated;
grant all on public.comment_likes to service_role;

drop policy if exists comment_likes_select_authenticated on public.comment_likes;
create policy comment_likes_select_authenticated
  on public.comment_likes for select
  to authenticated
  using (true);

drop policy if exists comment_likes_insert_own on public.comment_likes;
create policy comment_likes_insert_own
  on public.comment_likes for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists comment_likes_delete_own on public.comment_likes;
create policy comment_likes_delete_own
  on public.comment_likes for delete
  to authenticated
  using (user_id = (select auth.uid()));
