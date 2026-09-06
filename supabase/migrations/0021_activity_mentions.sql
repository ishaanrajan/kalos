-- =============================================================================
-- 0021_activity_mentions.sql
--
-- activity_feed() gains a fourth kind: 'mention' -- a comment (on ANY post,
-- not just your own, unlike the plain 'comment' case) whose body @mentions
-- you. This is a live scan over public.comments, not a stored event log, so
-- it backfills for free: every comment that already mentioned someone
-- starts showing up in their Activity tab the moment this migration runs,
-- with no separate backfill step.
--
-- Word-boundary-safe the same way lib/mentions.ts's client-side regex is:
-- '@ishaan' must be followed by end-of-string or a character outside the
-- mention charset ([a-z0-9._]), so '@ishaanfoo' doesn't falsely match
-- '@ishaan'. '.' is the only charset character that's also regex-special,
-- so it's the only one escaped before being spliced into the pattern.
--
-- Deliberately excludes a mention on your OWN post: the ordinary 'comment'
-- case below already surfaces that exact comment, so without this exclusion
-- "someone comments on your post and mentions you in it" would produce two
-- near-identical activity rows for one action. Same dedup notify/index.ts
-- already applies to the push notification for the identical reason.
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

    union all

    -- someone @mentioned me in a comment on someone else's post
    select
      'mention'::text             as kind,
      public.profile_json(ap.*)   as actor,
      c.post_id                   as post_id,
      po.image_path               as image_path,
      c.body                      as body,
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

revoke all on function public.activity_feed(int) from public;
grant execute on function public.activity_feed(int) to authenticated, service_role;
