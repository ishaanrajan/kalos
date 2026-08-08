-- =============================================================================
-- 0004_rls.sql
-- Row Level Security.
--
-- v1 policy: every account is public to signed-in users. That openness is what
-- makes Explore possible at all -- Explore never reaches outside the social
-- graph, but it does need to be able to *read* the graph.
--
-- Anonymous (unauthenticated) callers get nothing: no policy names `anon`.
-- =============================================================================

alter table public.profiles enable row level security;
alter table public.posts    enable row level security;
alter table public.follows  enable row level security;
alter table public.likes    enable row level security;
alter table public.comments enable row level security;

-- Table-level grants. RLS does the actual filtering; without these grants the
-- policies would never even be consulted.
grant select, insert, delete on public.profiles to authenticated;
grant select, insert, delete on public.posts    to authenticated;
grant select, insert, delete on public.follows  to authenticated;
grant select, insert, delete on public.likes    to authenticated;
grant select, insert, delete on public.comments to authenticated;

-- UPDATE is granted per column, not per table. The counter columns
-- (like_count, comment_count, post_count, follower_count, following_count) are
-- owned exclusively by the triggers in 0003; nobody can hand-write them, so no
-- account can inflate its own numbers. Attempting to do so fails with
-- "permission denied for column", which is the correct answer.
grant update (username, display_name, bio, avatar_path) on public.profiles to authenticated;
grant update (caption, filter_name)                     on public.posts    to authenticated;

grant all on public.profiles, public.posts, public.follows, public.likes, public.comments
  to service_role;

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------
drop policy if exists profiles_select_authenticated on public.profiles;
create policy profiles_select_authenticated
  on public.profiles for select
  to authenticated
  using (true);

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self
  on public.profiles for insert
  to authenticated
  with check (id = (select auth.uid()));

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No DELETE policy: profiles die with their auth.users row (ON DELETE CASCADE).

-- -----------------------------------------------------------------------------
-- posts
-- -----------------------------------------------------------------------------
drop policy if exists posts_select_authenticated on public.posts;
create policy posts_select_authenticated
  on public.posts for select
  to authenticated
  using (true);

drop policy if exists posts_insert_own on public.posts;
create policy posts_insert_own
  on public.posts for insert
  to authenticated
  with check (author_id = (select auth.uid()));

drop policy if exists posts_update_own on public.posts;
create policy posts_update_own
  on public.posts for update
  to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));

drop policy if exists posts_delete_own on public.posts;
create policy posts_delete_own
  on public.posts for delete
  to authenticated
  using (author_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- follows
-- -----------------------------------------------------------------------------
drop policy if exists follows_select_authenticated on public.follows;
create policy follows_select_authenticated
  on public.follows for select
  to authenticated
  using (true);

drop policy if exists follows_insert_own on public.follows;
create policy follows_insert_own
  on public.follows for insert
  to authenticated
  with check (follower_id = (select auth.uid()));

drop policy if exists follows_delete_own on public.follows;
create policy follows_delete_own
  on public.follows for delete
  to authenticated
  using (follower_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- likes
-- -----------------------------------------------------------------------------
drop policy if exists likes_select_authenticated on public.likes;
create policy likes_select_authenticated
  on public.likes for select
  to authenticated
  using (true);

drop policy if exists likes_insert_own on public.likes;
create policy likes_insert_own
  on public.likes for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists likes_delete_own on public.likes;
create policy likes_delete_own
  on public.likes for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- comments
-- -----------------------------------------------------------------------------
drop policy if exists comments_select_authenticated on public.comments;
create policy comments_select_authenticated
  on public.comments for select
  to authenticated
  using (true);

drop policy if exists comments_insert_own on public.comments;
create policy comments_insert_own
  on public.comments for insert
  to authenticated
  with check (author_id = (select auth.uid()));

-- A comment can be removed by its author, or by the owner of the post it sits
-- under (moderation of your own thread).
drop policy if exists comments_delete_author_or_post_owner on public.comments;
create policy comments_delete_author_or_post_owner
  on public.comments for delete
  to authenticated
  using (
    author_id = (select auth.uid())
    or exists (
      select 1
      from public.posts p
      where p.id = comments.post_id
        and p.author_id = (select auth.uid())
    )
  );
