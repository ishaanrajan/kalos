-- =============================================================================
-- 0036_activity_following_feed.sql
--
-- Activity gains a second feed: not just what happened on your own posts
-- (activity_feed(), the existing "YOU" behaviour), but what people you
-- follow are doing on posts generally -- 2015 Instagram's "FOLLOWING" tab
-- under the same heart icon.
--
-- Two branches only, like and comment. Deliberately narrower than
-- activity_feed(): a follow, an @mention, or a tag is already "about you"
-- specifically, which is what the YOU tab is for -- FOLLOWING is strictly
-- "someone I follow acted on some post," so those three kinds don't belong
-- here.
--
-- Graph-derived only, same as explore_feed() -- ordered strictly by
-- created_at, never by an engagement count. That's the one rule this whole
-- schema exists to enforce (see supabase/README.md); this function reads
-- the follow graph the exact same way explore_feed() and the mention/tag
-- branches of activity_feed() already do, just answering a different
-- question with it.
--
-- Excludes the viewer's own posts (po.author_id <> auth.uid()) so a like on
-- your own post by someone you follow doesn't show up twice across the two
-- tabs -- that's what YOU already covers. Excludes the viewer as actor for
-- the same reason a like/comment on your own post can't originate from you.
-- post_blocked() is reused verbatim from the mention/tag branches.
-- =============================================================================

create function public.activity_feed_following(lim int default 30)
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
  select a.kind, a.actor, a.post_id, a.image_path, a.thumb_path, a.body, a.created_at
  from (
    -- someone I follow liked a post (not their own, not mine)
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
    where exists (
            select 1 from public.follows vf
            where vf.follower_id = auth.uid() and vf.followee_id = l.user_id
          )
      and l.user_id <> auth.uid()
      and po.author_id <> auth.uid()
      and not public.post_blocked(po.author_id, auth.uid())

    union all

    -- someone I follow commented on a post (not their own, not mine)
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
    where exists (
            select 1 from public.follows vf
            where vf.follower_id = auth.uid() and vf.followee_id = c.author_id
          )
      and c.author_id <> auth.uid()
      and po.author_id <> auth.uid()
      and not public.post_blocked(po.author_id, auth.uid())
  ) a
  order by a.created_at desc
  limit least(greatest(coalesce(lim, 30), 1), 100);
$$;

revoke all on function public.activity_feed_following(int) from public;
grant execute on function public.activity_feed_following(int) to authenticated, service_role;
