-- =============================================================================
-- 0015_home_feed_comment_preview.sql
--
-- home_feed() gains preview_comments: the 2 most recent comments on each
-- post, so PostCard can show them inline the way it was already built to
-- (components/PostCard.tsx's previewComments prop existed but nothing ever
-- populated it -- this is that missing wiring).
--
-- The lateral-style subquery picks the 2 newest by created_at desc (cheap:
-- comments_post_created_idx from 0002_schema.sql is exactly this shape),
-- then re-sorts just those 2 ascending so they read top-to-bottom like an
-- actual short exchange rather than newest-first.
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

revoke all on function public.home_feed(timestamptz, uuid, int) from public;
grant execute on function public.home_feed(timestamptz, uuid, int) to authenticated, service_role;
