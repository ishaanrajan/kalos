-- =============================================================================
-- 0024_post_music.sql
--
-- Music on posts. A poster picks a track in the composer and chooses which
-- 15-second window of its 30s preview plays; viewers hear it automatically as
-- the post scrolls into view.
--
-- Stored as ONE jsonb column rather than six scalar columns. Six nullable
-- columns can represent a post with a title but no preview_url -- a broken
-- half-attached state every reader would have to defend against. A single
-- object is atomic: a post either has complete music or it has none, and the
-- check constraint below is what makes that true rather than merely intended.
-- home_feed already returns preview_comments as jsonb, so the shape is not a
-- new idea here. The TypeScript contract is PostMusic in lib/types.ts.
--
-- The catalog is Apple's iTunes Search API (see lib/music.ts): preview_url is
-- a 30s m4a served by Apple, store_url is the track's Store page. Both are
-- remote URLs, not Storage objects -- nothing here needs cleaning up when a
-- post is deleted.
--
-- Note there is deliberately no `grant update (music)` below. 0004_rls.sql
-- grants only (caption, filter_name); the song is chosen at capture time like
-- the filter is, and post-hoc editing is not part of this feature.
-- =============================================================================

alter table public.posts add column if not exists music jsonb;

-- A post either has complete music or none. Without this, every consumer would
-- have to handle a title with no audio behind it.
alter table public.posts drop constraint if exists posts_music_shape;
alter table public.posts add constraint posts_music_shape check (
  music is null or (
    jsonb_typeof(music) = 'object'
    and music ? 'track_id'
    and music ? 'title'
    and music ? 'artist'
    and music ? 'preview_url'
    and music ? 'store_url'
    and music ? 'start_ms'
    and jsonb_typeof(music -> 'start_ms') = 'number'
    and (music -> 'start_ms')::numeric >= 0
  )
);

-- -----------------------------------------------------------------------------
-- home_feed / explore_feed: add music to the returned shape. As in 0022,
-- Postgres can't CREATE OR REPLACE a function across a change in its return
-- columns, so both are dropped and recreated whole. Both bodies below are
-- 0022's verbatim -- the only edits are the added `music jsonb` return column
-- and the added `p.music` in each select list.
-- -----------------------------------------------------------------------------
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
          select cm.id, cm.body, cm.created_at, cp.username::text as username
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
    and (
          before is null
          or before_id is null
          or (p.created_at, p.id) < (before, before_id)
        )
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(lim, 12), 1), 50);
$$;

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
    and (
          before is null
          or before_id is null
          or (p.created_at, p.id) < (before, before_id)
        )
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(lim, 12), 1), 50);
$$;

revoke all on function public.home_feed(timestamptz, uuid, int)    from public;
revoke all on function public.explore_feed(timestamptz, uuid, int) from public;

grant execute on function public.home_feed(timestamptz, uuid, int)    to authenticated, service_role;
grant execute on function public.explore_feed(timestamptz, uuid, int) to authenticated, service_role;
