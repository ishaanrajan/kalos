-- =============================================================================
-- 0029_comment_gif.sql
--
-- GIF comments. A comment is now either typed text or a GIF sticker, never
-- both and never neither -- comments_content_shape below is what makes that
-- true rather than merely intended, the same reasoning posts_music_shape
-- (0024_post_music.sql) applies to a post's music. GIFs come from GIPHY
-- (see lib/giphy.ts); the GIF's own catalog id plus the fields needed to
-- display it are frozen into `gif` at send time, matching how a post's
-- PostMusic is frozen from a picked Track.
--
-- `body`'s existing `check (length(body) between 1 and 2200)` (0002_schema.sql)
-- is deliberately left untouched rather than replaced: in a Postgres CHECK
-- constraint a NULL result is treated as satisfied (not violated), and
-- `length(null) between 1 and 2200` evaluates to NULL -- so that original
-- constraint already tolerates a null body correctly, for free, once NOT
-- NULL is dropped below. No renamed/replacement constraint needed, and
-- nothing to guess about its auto-generated name.
--
-- No RLS policy changes: comments_insert_own (0004_rls.sql) already checks
-- only `author_id = auth.uid()`, which covers a GIF comment exactly as it
-- covers a text one. The shape constraints below are what enforce content,
-- not a new policy. Comments still have no update grant at all (0004), so a
-- GIF, like a post's music, is chosen once at send time and never edited.
-- =============================================================================

alter table public.comments add column if not exists gif jsonb;

alter table public.comments alter column body drop not null;

-- Exactly one of body/gif -- never both, never neither.
alter table public.comments drop constraint if exists comments_content_shape;
alter table public.comments add constraint comments_content_shape check (
  (body is not null and gif is null)
  or (body is null and gif is not null)
);

-- A GIF is either absent or a complete, displayable object. `url` should be a
-- size-capped GIPHY asset (e.g. `fixed_width`, not `original`) so a comment
-- row never has to load a multi-MB file; `preview_url` a small static/looping
-- still for a fast first paint; `width`/`height` describe whichever asset
-- `url` points to, so CommentRow can lay out the right aspect ratio before
-- the image itself has loaded.
alter table public.comments drop constraint if exists comments_gif_shape;
alter table public.comments add constraint comments_gif_shape check (
  gif is null or (
    jsonb_typeof(gif) = 'object'
    and gif ? 'giphy_id'
    and gif ? 'url'
    and gif ? 'preview_url'
    and gif ? 'width'
    and gif ? 'height'
    and jsonb_typeof(gif -> 'width') = 'number'
    and jsonb_typeof(gif -> 'height') = 'number'
  )
);

-- -----------------------------------------------------------------------------
-- home_feed(): preview_comments' subquery selected cm.body directly, which
-- would show a GIF-only comment's inline preview as an empty line. Return
-- columns are unchanged, so create or replace is enough -- no drop needed.
-- Verbatim copy of 0024's body except the one coalesce below.
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
    and (
          before is null
          or before_id is null
          or (p.created_at, p.id) < (before, before_id)
        )
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(lim, 12), 1), 50);
$$;

-- -----------------------------------------------------------------------------
-- activity_feed(): the 'comment' branch selected c.body directly, which would
-- render as the literal string "commented: null" once a comment's body can
-- actually be null. The 'mention' branch's body can never be null in
-- practice (a GIF comment has no text to match the @mention regex against,
-- so it never enters that branch to begin with), but it's coalesced too for
-- consistency and in case that ever changes. Return columns are unchanged.
-- -----------------------------------------------------------------------------
create or replace function public.activity_feed(lim int default 30)
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
  with me as (
    select username from public.profiles where id = auth.uid()
  )
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
      coalesce(c.body, '[GIF]')   as body,
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

    union all

    -- someone @mentioned me in a comment on someone else's post
    select
      'mention'::text             as kind,
      public.profile_json(ap.*)   as actor,
      c.post_id                   as post_id,
      po.image_path               as image_path,
      coalesce(c.body, '[GIF]')   as body,
      c.created_at                as created_at
    from public.comments c
    join public.posts po    on po.id = c.post_id
    join public.profiles ap on ap.id = c.author_id
    cross join me
    where c.author_id <> auth.uid()
      and po.author_id <> auth.uid()
      and c.body ~* ('@' || replace(me.username::text, '.', '\.') || '($|[^a-zA-Z0-9._])')
  ) a
  order by a.created_at desc
  limit least(greatest(coalesce(lim, 30), 1), 100);
$$;
