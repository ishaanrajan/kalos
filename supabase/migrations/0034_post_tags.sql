-- =============================================================================
-- 0034_post_tags.sql
--
-- Tagging people on a photo, the 2015 way: the author taps a spot on the
-- picture and picks a person; viewers tap the photo to see the name bubbles;
-- the tagged account gets a push, an Activity row, and the post in a
-- "Photos of you" grid on their profile.
--
-- Coordinates are fractions (0..1) of the *displayed* frame -- the
-- cover-cropped rectangle whose ratio the client derives from
-- posts.width/height (displayAspectRatio in components/PostCard.tsx) --
-- not pixels of the stored JPEG. Every surface fits the same already-cropped
-- pixels into a frame of that ratio, so a fraction lands on the same point
-- of the photo in the composer, the feed, and the post screen, and stays
-- right if the image is ever re-encoded at a different resolution.
--
-- Visibility follows the post. The select policy is "the post is visible to
-- you", evaluated as the caller, so posts_select_authenticated -- and with
-- it post_blocks (0031) -- decides; nothing here knows about blocks
-- directly. The two feed functions and activity_feed() are security definer
-- and bypass that policy, so they carry their own post_blocked() check, the
-- same way 0031 taught them to for posts.
--
-- Only the post's author may add a tag. Either the author or the tagged
-- account may delete one: that's what "remove me from this photo" and
-- "edit tags" will need, and granting it now costs nothing while no UI
-- exists for either yet. There is no update: a moved tag is a delete plus
-- an insert.
--
-- home_feed() and explore_feed() gain a `tags` return column, so their old
-- signatures have to be dropped first (create or replace refuses a changed
-- return type -- see 0033). Their bodies below are 0031's verbatim; only
-- the new column is different. activity_feed()'s return type is unchanged,
-- so it's a plain create or replace with a fifth branch. All three lose
-- their execute grants on drop and get them back at the bottom.
-- =============================================================================

create table if not exists public.post_tags (
  post_id    uuid not null references public.posts (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  x          real not null check (x >= 0 and x <= 1),
  y          real not null check (y >= 0 and y <= 1),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- "Photos of you": by tagged account, newest first.
create index if not exists post_tags_user_created_idx
  on public.post_tags (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Cap. The client stops at 20 too; this is the backstop for a client that
-- doesn't. Plain plpgsql, not security definer: it only counts rows of the
-- table being inserted into, which the author can already read.
-- -----------------------------------------------------------------------------
create or replace function public.post_tags_enforce_cap()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.post_tags t where t.post_id = new.post_id) >= 20 then
    raise exception 'a post can have at most 20 tags'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists post_tags_cap on public.post_tags;
create trigger post_tags_cap
  before insert on public.post_tags
  for each row execute function public.post_tags_enforce_cap();

-- -----------------------------------------------------------------------------
-- Grants + RLS. 0007 revoked the default privileges for new tables, so
-- these have to be spelled out.
-- -----------------------------------------------------------------------------
alter table public.post_tags enable row level security;
revoke all on public.post_tags from anon, authenticated;
grant select, insert, delete on public.post_tags to authenticated;
grant all on public.post_tags to service_role;

-- Readable exactly when the post is. The subquery runs as the caller, so
-- posts' own select policy (and the post_blocks check inside it) applies.
drop policy if exists post_tags_select_visible_post on public.post_tags;
create policy post_tags_select_visible_post
  on public.post_tags for select to authenticated
  using (
    exists (select 1 from public.posts p where p.id = post_id)
  );

drop policy if exists post_tags_insert_post_author on public.post_tags;
create policy post_tags_insert_post_author
  on public.post_tags for insert to authenticated
  with check (
    exists (
      select 1 from public.posts p
      where p.id = post_id and p.author_id = (select auth.uid())
    )
  );

drop policy if exists post_tags_delete_author_or_self on public.post_tags;
create policy post_tags_delete_author_or_self
  on public.post_tags for delete to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.posts p
      where p.id = post_id and p.author_id = (select auth.uid())
    )
  );

-- -----------------------------------------------------------------------------
-- home_feed(): 0031's body plus `tags`.
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

-- -----------------------------------------------------------------------------
-- activity_feed(): 0033's body plus a 'tag' branch. The actor is the post's
-- author -- the person who tagged you -- and the row links to their post.
-- -----------------------------------------------------------------------------
create or replace function public.activity_feed(lim int default 30)
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

    union all

    -- someone tagged me on one of their photos
    select
      'tag'::text                 as kind,
      public.profile_json(ap.*)   as actor,
      t.post_id                   as post_id,
      po.image_path               as image_path,
      po.thumb_path               as thumb_path,
      null::text                  as body,
      t.created_at                as created_at
    from public.post_tags t
    join public.posts po    on po.id = t.post_id
    join public.profiles ap on ap.id = po.author_id
    where t.user_id = auth.uid()
      and po.author_id <> auth.uid()
      and not public.post_blocked(po.author_id, auth.uid())
  ) a
  order by a.created_at desc
  limit least(greatest(coalesce(lim, 30), 1), 100);
$$;

-- -----------------------------------------------------------------------------
-- Grants. The two dropped functions lost theirs; re-asserting all three
-- keeps this file self-contained.
-- -----------------------------------------------------------------------------
revoke all on function public.home_feed(timestamptz, uuid, int)    from public;
revoke all on function public.explore_feed(timestamptz, uuid, int) from public;
revoke all on function public.activity_feed(int)                   from public;

grant execute on function public.home_feed(timestamptz, uuid, int)    to authenticated, service_role;
grant execute on function public.explore_feed(timestamptz, uuid, int) to authenticated, service_role;
grant execute on function public.activity_feed(int)                   to authenticated, service_role;
