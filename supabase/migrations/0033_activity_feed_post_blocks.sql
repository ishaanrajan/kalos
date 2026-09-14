-- =============================================================================
-- 0033_activity_feed_post_blocks.sql
--
-- activity_feed() is security definer, so it reads posts with the owner's
-- privileges and never goes through posts_select_authenticated -- the policy
-- that 0031 taught to hide a blocker's posts from the account they blocked.
-- Three of its four branches are safe regardless: like/comment rows are
-- scoped to posts the viewer authored, and follow rows carry no post. The
-- mention branch is not: a comment that @mentions the blocked account on the
-- blocker's post surfaced as an activity row, thumbnail included (the photos
-- bucket is public, so it rendered), and tapping it opened /post/<id> where
-- RLS hides the row and the screen errors out.
--
-- Same fix shape as home_feed()/explore_feed() in 0031: filter the row out
-- with post_blocked().
--
-- While the function is being replaced anyway: it also now returns
-- thumb_path. The Activity tab's 44pt thumbnails were the one grid context
-- still downloading the full-size original per row (up to 50 of them),
-- because this was the one post-returning function without it. The client
-- treats the column as optional, so it keeps working against a database
-- where this migration hasn't run yet. A changed return type means the old
-- signature has to be dropped first; create or replace refuses otherwise.
-- =============================================================================

drop function if exists public.activity_feed(int);

create function public.activity_feed(lim int default 30)
returns table (
  kind       text,
  actor      jsonb,
  post_id    uuid,
  image_path text,
  thumb_path text,
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
  select a.kind, a.actor, a.post_id, a.image_path, a.thumb_path, a.body, a.created_at
  from (
    -- someone liked one of my posts
    select
      'like'::text                as kind,
      public.profile_json(ap.*)   as actor,
      l.post_id                   as post_id,
      po.image_path               as image_path,
      po.thumb_path               as thumb_path,
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
      po.thumb_path               as thumb_path,
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
      null::text                  as thumb_path,
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
      po.thumb_path               as thumb_path,
      coalesce(c.body, '[GIF]')   as body,
      c.created_at                as created_at
    from public.comments c
    join public.posts po    on po.id = c.post_id
    join public.profiles ap on ap.id = c.author_id
    cross join me
    where c.author_id <> auth.uid()
      and po.author_id <> auth.uid()
      and not public.post_blocked(po.author_id, auth.uid())
      and c.body ~* ('@' || replace(me.username::text, '.', '\.') || '($|[^a-zA-Z0-9._])')
  ) a
  order by a.created_at desc
  limit least(greatest(coalesce(lim, 30), 1), 100);
$$;

revoke all on function public.activity_feed(int) from public;
grant execute on function public.activity_feed(int) to authenticated, service_role;
