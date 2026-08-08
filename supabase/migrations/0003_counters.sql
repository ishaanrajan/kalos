-- =============================================================================
-- 0003_counters.sql
-- Denormalised counter maintenance + auth.users -> profiles bootstrap.
--
-- Every trigger function is SECURITY DEFINER so that, for example, user A
-- liking user B's post can still bump posts.like_count on a row that RLS would
-- never let A update directly.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- New user -> profile row
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  requested text;
  base      text;
  candidate text;
  n         int := 0;
begin
  requested := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'username'), ''),
    split_part(coalesce(new.email, ''), '@', 1)
  );

  -- Coerce into the charset allowed by profiles_username_format.
  base := regexp_replace(lower(coalesce(requested, '')), '[^a-z0-9._]', '', 'g');
  if length(base) < 3 then
    base := 'user' || replace(substr(new.id::text, 1, 8), '-', '');
  end if;
  base := substr(base, 1, 30);

  -- Resolve collisions: alice, alice_1, alice_2, ...
  candidate := base;
  -- Explicit ::citext: without it, citext's implicit cast *to* text would make
  -- Postgres pick the text = text operator and compare case-sensitively.
  while exists (select 1 from public.profiles p where p.username = candidate::citext) loop
    n := n + 1;
    candidate := substr(base, 1, greatest(1, 30 - (length(n::text) + 1))) || '_' || n::text;
  end loop;

  insert into public.profiles (id, username, display_name, avatar_path, bio)
  values (
    new.id,
    candidate,
    nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'avatar_path'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'bio'), '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- posts.like_count
-- -----------------------------------------------------------------------------
create or replace function public.tg_likes_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set like_count = like_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    -- No-op when the parent post is being cascade-deleted; that is fine.
    update public.posts set like_count = greatest(like_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

drop trigger if exists likes_counts_aiud on public.likes;
create trigger likes_counts_aiud
  after insert or delete on public.likes
  for each row execute function public.tg_likes_counts();

-- -----------------------------------------------------------------------------
-- posts.comment_count
-- -----------------------------------------------------------------------------
create or replace function public.tg_comments_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set comment_count = comment_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update public.posts set comment_count = greatest(comment_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

drop trigger if exists comments_counts_aiud on public.comments;
create trigger comments_counts_aiud
  after insert or delete on public.comments
  for each row execute function public.tg_comments_counts();

-- -----------------------------------------------------------------------------
-- profiles.post_count
-- -----------------------------------------------------------------------------
create or replace function public.tg_posts_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.profiles set post_count = post_count + 1 where id = new.author_id;
  elsif tg_op = 'DELETE' then
    update public.profiles set post_count = greatest(post_count - 1, 0) where id = old.author_id;
  end if;
  return null;
end;
$$;

drop trigger if exists posts_counts_aiud on public.posts;
create trigger posts_counts_aiud
  after insert or delete on public.posts
  for each row execute function public.tg_posts_counts();

-- -----------------------------------------------------------------------------
-- profiles.follower_count / profiles.following_count
--
-- Both sides are touched by a single UPDATE so the two rows are locked in a
-- stable order, which keeps concurrent follow/unfollow pairs from deadlocking.
-- -----------------------------------------------------------------------------
create or replace function public.tg_follows_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.profiles p
       set follower_count  = p.follower_count  + (case when p.id = new.followee_id then 1 else 0 end),
           following_count = p.following_count + (case when p.id = new.follower_id then 1 else 0 end)
     where p.id in (new.followee_id, new.follower_id);
  elsif tg_op = 'DELETE' then
    update public.profiles p
       set follower_count  = greatest(p.follower_count  - (case when p.id = old.followee_id then 1 else 0 end), 0),
           following_count = greatest(p.following_count - (case when p.id = old.follower_id then 1 else 0 end), 0)
     where p.id in (old.followee_id, old.follower_id);
  end if;
  return null;
end;
$$;

drop trigger if exists follows_counts_aiud on public.follows;
create trigger follows_counts_aiud
  after insert or delete on public.follows
  for each row execute function public.tg_follows_counts();

-- -----------------------------------------------------------------------------
-- Maintenance: recompute every counter from scratch.
-- Safe to run any time; the seed script calls it as a final consistency check.
-- -----------------------------------------------------------------------------
create or replace function public.recompute_counters()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.posts p
     set like_count = coalesce(c.n, 0)
    from (select l.post_id, count(*)::int as n from public.likes l group by l.post_id) c
   where c.post_id = p.id and p.like_count is distinct from c.n;

  update public.posts p
     set like_count = 0
   where p.like_count <> 0
     and not exists (select 1 from public.likes l where l.post_id = p.id);

  update public.posts p
     set comment_count = coalesce(c.n, 0)
    from (select cm.post_id, count(*)::int as n from public.comments cm group by cm.post_id) c
   where c.post_id = p.id and p.comment_count is distinct from c.n;

  update public.posts p
     set comment_count = 0
   where p.comment_count <> 0
     and not exists (select 1 from public.comments cm where cm.post_id = p.id);

  update public.profiles pr
     set post_count      = (select count(*)::int from public.posts    po where po.author_id  = pr.id),
         follower_count  = (select count(*)::int from public.follows  f  where f.followee_id = pr.id),
         following_count = (select count(*)::int from public.follows  f  where f.follower_id = pr.id);
end;
$$;

-- Maintenance only: reachable by the seed script (service_role), never by app users.
revoke all on function public.recompute_counters() from public, anon, authenticated;
grant execute on function public.recompute_counters() to service_role;
