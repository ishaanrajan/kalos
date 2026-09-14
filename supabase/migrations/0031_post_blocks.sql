-- =============================================================================
-- 0031_post_blocks.sql
--
-- Lets one account hide their posts from a specific other account -- not a
-- general mutual/visible "block" feature (follows, DMs, comments, and likes
-- between the two accounts are all untouched), just post visibility, and
-- one-directional: the blocker keeps seeing the blocked viewer's own posts
-- normally, only the reverse is cut off.
--
-- No client-facing UI or RLS grant for managing this yet -- rows are
-- inserted directly (service role) on request, the same way dm_peer_pairs
-- (0027_dm_peer_sandbox.sql) started as an admin-managed allowlist before
-- any UI existed for it. Unlike dm_peer_pairs, there is deliberately no
-- `grant select ... to authenticated` here either: whether someone has
-- blocked you is not information the blocked account should be able to
-- read out of the database, even if they can already infer it from a post
-- going missing.
--
-- Enforced in three places rather than one, because posts reach a viewer
-- through three different paths and only one of them is actually governed
-- by posts' own RLS: `home_feed()`/`explore_feed()` are `security definer`,
-- which runs their queries as the function owner and bypasses RLS on
-- `posts` entirely -- their own WHERE clauses are the only enforcement
-- they have, the same reason they already hand-filter by the follow graph
-- instead of relying on a table policy. A direct `.from('posts')` select
-- (profile grids, via useProfilePosts) is the one path RLS actually
-- covers.
-- =============================================================================

create table if not exists public.post_blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint post_blocks_no_self check (blocker_id <> blocked_id),
  primary key (blocker_id, blocked_id)
);

alter table public.post_blocks enable row level security;
revoke all on public.post_blocks from anon, authenticated;
grant all on public.post_blocks to service_role;

-- -----------------------------------------------------------------------------
-- post_blocked(author, viewer) -- true if `author` has blocked `viewer`
-- from seeing their posts. One predicate, reused by the RLS policy and
-- both feed functions below, so the three enforcement points can't drift
-- out of sync with each other.
-- -----------------------------------------------------------------------------
create or replace function public.post_blocked(author uuid, viewer uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.post_blocks
    where blocker_id = author and blocked_id = viewer
  );
$$;

-- -----------------------------------------------------------------------------
-- posts RLS: covers direct table selects (profile grids, etc.) that don't
-- go through either feed RPC.
-- -----------------------------------------------------------------------------
drop policy if exists posts_select_authenticated on public.posts;
create policy posts_select_authenticated
  on public.posts for select
  to authenticated
  using (not public.post_blocked(author_id, (select auth.uid())));

-- -----------------------------------------------------------------------------
-- home_feed(): same as 0029's version, plus the block check. Return
-- columns are unchanged, so create or replace is enough.
-- -----------------------------------------------------------------------------
create or replace function public.home_feed(
  before    timestamptz default null,
  before_id uuid        default null,
  lim       int         default 12
)
returns table (
  id                  uuid,
  author_id           uuid,
  image_path          text,
  thumb_path          text,
  width               int,
  height              int,
  caption             text,
  filter_name         text,
  music               jsonb,
  like_count          int,
  comment_count       int,
  created_at          timestamptz,
  author_username     text,
  author_display_name text,
  author_avatar_path  text,
  viewer_has_liked    boolean,
  preview_comments    jsonb
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    p.id,
    p.author_id,
    p.image_path,
    p.thumb_path,
    p.width,
    p.height,
    p.caption,
    p.filter_name,
    p.music,
    p.like_count,
    p.comment_count,
    p.created_at,
    pr.username::text,
    pr.display_name,
    pr.avatar_path,
    exists (
      select 1
      from public.likes vl
      where vl.post_id = p.id
        and vl.user_id = auth.uid()
    ) as viewer_has_liked,
    coalesce(
      (
        select jsonb_agg(c order by c.created_at asc)
        from (
          select cm.id, coalesce(cm.body, '[GIF]') as body, cm.created_at, cp.username::text as username
          from public.comments cm
          join public.profiles cp on cp.id = cm.author_id
          where cm.post_id = p.id
          order by cm.created_at desc
          limit 2
        ) c
      ),
      '[]'::jsonb
    ) as preview_comments
  from public.posts p
  join public.profiles pr on pr.id = p.author_id
  where (
          p.author_id = auth.uid()
          or exists (
               select 1
               from public.follows vf
               where vf.follower_id = auth.uid()
                 and vf.followee_id = p.author_id
             )
        )
    and not public.post_blocked(p.author_id, auth.uid())
    and (
          before is null
          or before_id is null
          or (p.created_at, p.id) < (before, before_id)
        )
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(lim, 12), 1), 50);
$$;

-- -----------------------------------------------------------------------------
-- explore_feed(): same as 0024's version, plus the block check. Return
-- columns are unchanged, so create or replace is enough.
-- -----------------------------------------------------------------------------
create or replace function public.explore_feed(
  before    timestamptz default null,
  before_id uuid        default null,
  lim       int         default 12
)
returns table (
  id                  uuid,
  author_id           uuid,
  image_path          text,
  thumb_path          text,
  width               int,
  height              int,
  caption             text,
  filter_name         text,
  music               jsonb,
  like_count          int,
  comment_count       int,
  created_at          timestamptz,
  author_username     text,
  author_display_name text,
  author_avatar_path  text,
  viewer_has_liked    boolean,
  reason              text,
  reason_username     text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    p.id,
    p.author_id,
    p.image_path,
    p.thumb_path,
    p.width,
    p.height,
    p.caption,
    p.filter_name,
    p.music,
    p.like_count,
    p.comment_count,
    p.created_at,
    pr.username::text,
    pr.display_name,
    pr.avatar_path,
    exists (
      select 1
      from public.likes vl
      where vl.post_id = p.id
        and vl.user_id = auth.uid()
    ) as viewer_has_liked,
    r.reason,
    r.reason_username
  from public.posts p
  join public.profiles pr on pr.id = p.author_id
  cross join lateral (
    select rr.reason, rr.reason_username
    from (
      -- (a) liked by an account the viewer follows
      select
        'liked_by'::text     as reason,
        lpr.username::text   as reason_username,
        1                    as prio,
        l.created_at         as at_ts
      from public.likes l
      join public.profiles lpr on lpr.id = l.user_id
      where l.post_id = p.id
        and l.user_id <> auth.uid()
        and exists (
              select 1
              from public.follows vf
              where vf.follower_id = auth.uid()
                and vf.followee_id = l.user_id
            )

      union all

      -- (b) author is followed by an account the viewer follows
      select
        'followed_by'::text  as reason,
        fpr.username::text   as reason_username,
        2                    as prio,
        af.created_at        as at_ts
      from public.follows af
      join public.profiles fpr on fpr.id = af.follower_id
      where af.followee_id = p.author_id
        and af.follower_id <> auth.uid()
        and exists (
              select 1
              from public.follows vf2
              where vf2.follower_id = auth.uid()
                and vf2.followee_id = af.follower_id
            )
    ) rr
    order by rr.prio asc, rr.at_ts desc, rr.reason_username asc
    limit 1
  ) r
  where p.author_id <> auth.uid()
    and not exists (
          select 1
          from public.follows vfa
          where vfa.follower_id = auth.uid()
            and vfa.followee_id = p.author_id
        )
    and not public.post_blocked(p.author_id, auth.uid())
    and (
          before is null
          or before_id is null
          or (p.created_at, p.id) < (before, before_id)
        )
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(lim, 12), 1), 50);
$$;

-- -----------------------------------------------------------------------------
-- luliakl asked not to be seen by 0_o.
-- -----------------------------------------------------------------------------
insert into public.post_blocks (blocker_id, blocked_id)
select l.id, o.id
from public.profiles l, public.profiles o
where l.username = 'luliakl' and o.username = '0_o'
on conflict do nothing;
