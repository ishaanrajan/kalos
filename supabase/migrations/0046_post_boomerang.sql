-- =============================================================================
-- 0046_post_boomerang.sql
--
-- Boomerangs: a short burst of frames that plays forward, then backward, then
-- loops. Instagram shipped Boomerang in October 2015, squarely the era this
-- app rebuilds.
--
-- A boomerang is stored as ONE image, not N. The frames are stitched into a
-- single JPEG sprite sheet at capture time (lib/boomerang.ts) and sliced back
-- out per frame at playback. That one choice carries most of the weight:
--
--   * one upload, one download, one decode instead of twelve of each
--   * the filter pipeline needs no changes whatsoever -- a single colour
--     matrix over the sheet covers every frame at once
--   * it is atomic. There is no such thing as a half-uploaded boomerang, so
--     nothing downstream has to cope with frame 7 of 12 being missing
--
-- So `image_path` still points at an ordinary image and nothing about storage,
-- RLS or the upload path changes. This column only describes how to *read*
-- that image: how many frames are in it, how they're laid out, how fast to
-- play them. A null `boomerang` means the image is what it has always been --
-- a single still.
--
-- Same jsonb-object shape as `music` (0024), for the same reason: the parts
-- are useless individually, so the constraint below makes a post carry either
-- a complete boomerang or none at all.
-- =============================================================================

alter table public.posts add column if not exists boomerang jsonb;

-- frames/cols/rows/fps are all needed to read the sheet at all -- a sheet
-- whose grid you don't know is just an unusually large photo.
alter table public.posts drop constraint if exists posts_boomerang_shape;
alter table public.posts add constraint posts_boomerang_shape check (
  boomerang is null or (
    jsonb_typeof(boomerang) = 'object'
    and jsonb_typeof(boomerang -> 'frames') = 'number'
    and jsonb_typeof(boomerang -> 'cols') = 'number'
    and jsonb_typeof(boomerang -> 'rows') = 'number'
    and jsonb_typeof(boomerang -> 'fps') = 'number'
    and (boomerang -> 'frames')::int between 2 and 60
    and (boomerang -> 'cols')::int >= 1
    and (boomerang -> 'rows')::int >= 1
    -- the grid must be able to hold the frames it claims to
    and (boomerang -> 'cols')::int * (boomerang -> 'rows')::int >= (boomerang -> 'frames')::int
    and (boomerang -> 'fps')::numeric between 1 and 60
  )
);

-- Deliberately no `grant update (boomerang)`: like `music` (0024), the frame
-- layout describes bytes that were fixed at upload time. Letting a client
-- rewrite it after the fact would just be a way to make image_path unreadable.

-- -----------------------------------------------------------------------------
-- home_feed / explore_feed: add boomerang to the returned shape. As in 0022,
-- 0024 and 0034, Postgres can't CREATE OR REPLACE a function across a change
-- in its return columns, so both are dropped and recreated whole. Both bodies
-- below are 0034's verbatim -- the only edits are the added `boomerang jsonb`
-- return column and the added `p.boomerang` in each select list.
--
-- activity_feed is deliberately untouched: it returns an event log rather than
-- post columns, so a boomerang shows up there as the still it already was.
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
  boomerang           jsonb,
  like_count          int,
  comment_count       int,
  created_at          timestamptz,
  author_username     text,
  author_display_name text,
  author_avatar_path  text,
  viewer_has_liked    boolean,
  preview_comments    jsonb,
  tags                jsonb
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
    p.boomerang,
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
    ) as preview_comments,
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'user_id',  t.user_id,
                   'username', tp.username::text,
                   'x',        t.x,
                   'y',        t.y
                 )
                 order by t.created_at asc
               )
        from public.post_tags t
        join public.profiles tp on tp.id = t.user_id
        where t.post_id = p.id
      ),
      '[]'::jsonb
    ) as tags
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
-- explore_feed(): 0031's body plus `tags`.
-- -----------------------------------------------------------------------------
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
  boomerang           jsonb,
  like_count          int,
  comment_count       int,
  created_at          timestamptz,
  author_username     text,
  author_display_name text,
  author_avatar_path  text,
  viewer_has_liked    boolean,
  reason              text,
  reason_username     text,
  tags                jsonb
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
    p.boomerang,
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
    r.reason_username,
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'user_id',  t.user_id,
                   'username', tp.username::text,
                   'x',        t.x,
                   'y',        t.y
                 )
                 order by t.created_at asc
               )
        from public.post_tags t
        join public.profiles tp on tp.id = t.user_id
        where t.post_id = p.id
      ),
      '[]'::jsonb
    ) as tags
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
