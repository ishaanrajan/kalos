-- =============================================================================
-- 0006_feed_functions.sql
-- The RPCs the app actually reads through.
--
-- THE ONE RULE: `like_count` never appears in an ORDER BY. Not here, not
-- anywhere. Every feed in Kalos is strictly reverse-chronological, and
-- Explore's candidate set comes only from the viewer's social graph. If you
-- ever find yourself adding a score column, you are building a different app.
--
-- Ambiguity note: these functions use RETURNS TABLE, which puts the output
-- column names (id, created_at, ...) into scope as if they were variables.
-- EVERY column reference below is therefore table-qualified. Do not "tidy up"
-- an alias away.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- helpers
-- -----------------------------------------------------------------------------

-- Serialise a profiles row into the `Profile` shape from lib/types.ts.
create or replace function public.profile_json(p public.profiles)
returns jsonb
language sql
immutable
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'id',              p.id,
    'username',        p.username::text,
    'display_name',    p.display_name,
    'bio',             p.bio,
    'avatar_path',     p.avatar_path,
    'post_count',      p.post_count,
    'follower_count',  p.follower_count,
    'following_count', p.following_count,
    'created_at',      p.created_at
  );
$$;

-- Escape LIKE metacharacters in user-supplied search text.
create or replace function public.like_escape(t text)
returns text
language sql
immutable
as $$
  select replace(replace(replace(coalesce($1, ''), '\', '\\'), '%', '\%'), '_', '\_');
$$;

-- =============================================================================
-- home_feed(before, before_id, lim)
--
-- Your own posts + the posts of everyone you follow, newest first.
-- Keyset paginated on (created_at, id) DESC, which is exactly the shape of the
-- posts_created_id_idx index.
-- =============================================================================
drop function if exists public.home_feed(timestamptz, uuid, int);
create function public.home_feed(
  before    timestamptz default null,
  before_id uuid        default null,
  lim       int         default 12
)
returns table (
  id                  uuid,
  author_id           uuid,
  image_path          text,
  width               int,
  height              int,
  caption             text,
  filter_name         text,
  like_count          int,
  comment_count       int,
  created_at          timestamptz,
  author_username     text,
  author_display_name text,
  author_avatar_path  text,
  viewer_has_liked    boolean
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
    p.width,
    p.height,
    p.caption,
    p.filter_name,
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
    ) as viewer_has_liked
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
    and (
          before is null
          or before_id is null
          or (p.created_at, p.id) < (before, before_id)
        )
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(lim, 12), 1), 50);
$$;

-- =============================================================================
-- explore_feed(before, before_id, lim)
--
-- Posts you are NOT already connected to directly, reachable in exactly two
-- hops through the graph:
--   (a) someone you follow liked it            -> reason 'liked_by'
--   (b) someone you follow follows the author  -> reason 'followed_by'
--
-- Excluded: your own posts, and posts by anyone you already follow (those
-- belong in home_feed).
--
-- Ordering is (created_at, id) DESC and nothing else. A post with 10,000 likes
-- from outside your graph is not in the candidate set at all.
--
-- The CROSS JOIN LATERAL ... LIMIT 1 does three jobs at once: it filters out
-- posts with no connection (zero lateral rows drops the outer row), it
-- deduplicates (at most one row per post), and it picks the reason label with
-- 'liked_by' preferred over 'followed_by'.
-- =============================================================================
drop function if exists public.explore_feed(timestamptz, uuid, int);
create function public.explore_feed(
  before    timestamptz default null,
  before_id uuid        default null,
  lim       int         default 12
)
returns table (
  id                  uuid,
  author_id           uuid,
  image_path          text,
  width               int,
  height              int,
  caption             text,
  filter_name         text,
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
    p.width,
    p.height,
    p.caption,
    p.filter_name,
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
    and (
          before is null
          or before_id is null
          or (p.created_at, p.id) < (before, before_id)
        )
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(lim, 12), 1), 50);
$$;

-- =============================================================================
-- activity_feed(lim)
--
-- Likes and comments on the viewer's own posts, plus new followers.
-- Newest first, never reordered. Matches the ActivityEvent union in
-- lib/types.ts: a discriminated `kind` plus nullable per-variant columns.
-- `actor` is a JSON object in the `Profile` shape.
-- =============================================================================
drop function if exists public.activity_feed(int);
create function public.activity_feed(lim int default 30)
returns table (
  kind       text,
  actor      jsonb,
  post_id    uuid,
  image_path text,
  body       text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select a.kind, a.actor, a.post_id, a.image_path, a.body, a.created_at
  from (
    -- someone liked one of my posts
    select
      'like'::text                as kind,
      public.profile_json(ap.*)   as actor,
      l.post_id                   as post_id,
      po.image_path               as image_path,
      null::text                  as body,
      l.created_at                as created_at
    from public.likes l
    join public.posts po    on po.id = l.post_id
    join public.profiles ap on ap.id = l.user_id
    where po.author_id = auth.uid()
      and l.user_id <> auth.uid()

    union all

    -- someone commented on one of my posts
    select
      'comment'::text             as kind,
      public.profile_json(ap.*)   as actor,
      c.post_id                   as post_id,
      po.image_path               as image_path,
      c.body                      as body,
      c.created_at                as created_at
    from public.comments c
    join public.posts po    on po.id = c.post_id
    join public.profiles ap on ap.id = c.author_id
    where po.author_id = auth.uid()
      and c.author_id <> auth.uid()

    union all

    -- someone followed me
    select
      'follow'::text              as kind,
      public.profile_json(ap.*)   as actor,
      null::uuid                  as post_id,
      null::text                  as image_path,
      null::text                  as body,
      f.created_at                as created_at
    from public.follows f
    join public.profiles ap on ap.id = f.follower_id
    where f.followee_id = auth.uid()
  ) a
  order by a.created_at desc
  limit least(greatest(coalesce(lim, 30), 1), 100);
$$;

-- =============================================================================
-- search_profiles(q, lim)
--
-- Prefix match on username or display_name. Exact username match floats to the
-- top, then alphabetical. Note what is NOT in the ORDER BY: follower_count.
-- =============================================================================
drop function if exists public.search_profiles(text, int);
create function public.search_profiles(q text, lim int default 20)
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
  with needle as (
    select
      lower(btrim(coalesce(q, ''))) as term,
      public.like_escape(lower(btrim(coalesce(q, '')))) as pat
  )
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
  cross join needle n
  where length(n.term) > 0
    and (
      pr.username::text like n.pat || '%'
      or lower(coalesce(pr.display_name, '')) like n.pat || '%'
    )
  order by
    (pr.username::text = n.term) desc,
    (pr.username::text like n.pat || '%') desc,
    pr.username::text asc
  limit least(greatest(coalesce(lim, 20), 1), 50);
$$;

-- -----------------------------------------------------------------------------
-- Execution grants.
-- These are SECURITY DEFINER, so PUBLIC's implicit EXECUTE is revoked first.
-- -----------------------------------------------------------------------------
revoke all on function public.home_feed(timestamptz, uuid, int)    from public;
revoke all on function public.explore_feed(timestamptz, uuid, int) from public;
revoke all on function public.activity_feed(int)                   from public;
revoke all on function public.search_profiles(text, int)           from public;

grant execute on function public.home_feed(timestamptz, uuid, int)    to authenticated, service_role;
grant execute on function public.explore_feed(timestamptz, uuid, int) to authenticated, service_role;
grant execute on function public.activity_feed(int)                   to authenticated, service_role;
grant execute on function public.search_profiles(text, int)           to authenticated, service_role;

grant execute on function public.profile_json(public.profiles) to authenticated, service_role;
grant execute on function public.like_escape(text)             to authenticated, service_role;
