-- =============================================================================
-- 0017_suggested_profiles.sql
--
-- suggested_profiles(lim)
--
-- Powers the "suggested accounts" list under the search bar. Same rule as
-- everywhere else in this app: no engagement ranking. This reuses Explore's
-- 'followed_by' logic -- people followed by people you follow -- just applied
-- to accounts instead of posts, ordered by when that graph connection formed.
-- follower_count never appears here, same as search_profiles.
--
-- No backfill: someone who follows nobody gets an empty list, same as they'd
-- get an empty Explore. This never reaches for a popular stranger to fill
-- the 5 slots.
-- =============================================================================
drop function if exists public.suggested_profiles(int);
create function public.suggested_profiles(lim int default 5)
returns table (
  id              uuid,
  username        text,
  display_name    text,
  bio             text,
  avatar_path     text,
  post_count      int,
  follower_count  int,
  following_count int,
  created_at      timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    pr.id,
    pr.username::text,
    pr.display_name,
    pr.bio,
    pr.avatar_path,
    pr.post_count,
    pr.follower_count,
    pr.following_count,
    pr.created_at
  from public.profiles pr
  join lateral (
    -- Most recent follow, by someone the viewer follows, that points at pr.
    -- The lateral join both filters to "reachable at all" (zero rows drops
    -- the candidate) and gives an ORDER BY key that isn't engagement.
    select af.created_at
    from public.follows af
    where af.followee_id = pr.id
      and af.follower_id <> auth.uid()
      and exists (
            select 1
            from public.follows vf
            where vf.follower_id = auth.uid()
              and vf.followee_id = af.follower_id
          )
    order by af.created_at desc
    limit 1
  ) c on true
  where pr.id <> auth.uid()
    and not exists (
          select 1
          from public.follows vfa
          where vfa.follower_id = auth.uid()
            and vfa.followee_id = pr.id
        )
  order by c.created_at desc, pr.id desc
  limit least(greatest(coalesce(lim, 5), 1), 20);
$$;

revoke all on function public.suggested_profiles(int) from public;
grant execute on function public.suggested_profiles(int) to authenticated, service_role;
