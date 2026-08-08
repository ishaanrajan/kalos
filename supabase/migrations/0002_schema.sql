-- =============================================================================
-- 0002_schema.sql
-- Core tables + indexes.
--
-- Column names here are the contract in lib/types.ts. Do not rename without
-- changing that file first.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  username        extensions.citext not null unique,
  display_name    text,
  bio             text,
  avatar_path     text,
  post_count      int not null default 0,
  follower_count  int not null default 0,
  following_count int not null default 0,
  created_at      timestamptz not null default now()
);

-- Lowercase alphanumerics, dots and underscores, 3-30 chars.
-- username is citext, so the regex is cast to text to force *stored* lowercase
-- (a citext ~ match would otherwise be case-insensitive and let "Bob" through).
do $$
begin
  alter table public.profiles
    add constraint profiles_username_format
    check ((username::text) ~ '^[a-z0-9._]{3,30}$');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter table public.profiles
    add constraint profiles_bio_length check (bio is null or length(bio) <= 300);
exception
  when duplicate_object then null;
end
$$;

-- -----------------------------------------------------------------------------
-- posts
-- -----------------------------------------------------------------------------
create table if not exists public.posts (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null references public.profiles (id) on delete cascade,
  image_path    text not null,
  -- NOT NULL with a square default: lib/types.ts declares Post.width/height as
  -- non-nullable numbers, and 2015-era Instagram was square.
  width         int not null default 1080,
  height        int not null default 1080,
  caption       text,
  filter_name   text,
  like_count    int not null default 0,
  comment_count int not null default 0,
  created_at    timestamptz not null default now()
);

do $$
begin
  alter table public.posts
    add constraint posts_caption_length check (caption is null or length(caption) <= 2200);
exception
  when duplicate_object then null;
end
$$;

-- -----------------------------------------------------------------------------
-- follows
-- -----------------------------------------------------------------------------
create table if not exists public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  followee_id uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint follows_no_self check (follower_id <> followee_id)
);

-- -----------------------------------------------------------------------------
-- likes
-- -----------------------------------------------------------------------------
create table if not exists public.likes (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  post_id    uuid not null references public.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

-- -----------------------------------------------------------------------------
-- comments
-- -----------------------------------------------------------------------------
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts (id) on delete cascade,
  author_id  uuid not null references public.profiles (id) on delete cascade,
  body       text not null check (length(body) between 1 and 2200),
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Indexes
--
-- Every read path in this app is "newest first". These indexes exist to make
-- (created_at DESC, id DESC) keyset pagination an index scan. There is
-- deliberately no index on like_count -- nothing ever orders by it.
-- -----------------------------------------------------------------------------
create index if not exists posts_author_created_idx
  on public.posts (author_id, created_at desc);

create index if not exists posts_created_id_idx
  on public.posts (created_at desc, id desc);

create index if not exists follows_follower_idx on public.follows (follower_id);
create index if not exists follows_followee_idx on public.follows (followee_id);

create index if not exists likes_post_idx on public.likes (post_id);
create index if not exists likes_user_idx on public.likes (user_id);

create index if not exists comments_post_created_idx
  on public.comments (post_id, created_at desc);

-- Prefix search on display_name (username already has the unique citext index).
create index if not exists profiles_display_name_idx
  on public.profiles (lower(display_name));
