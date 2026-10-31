-- =============================================================================
-- 0047_halloween_chat.sql
--
-- A one-day, anonymous group chat for Halloween 2026. Separate from
-- dm_messages (a (thread_user_id, thread_with_id) pair has no concept of
-- "everyone").
--
-- Anonymity is enforced in the data, not the UI: the table clients can read
-- and subscribe to (group_chat_messages) has NO sender column at all, so
-- neither a query nor a Realtime payload can reveal who wrote a message. The
-- real author lives in group_chat_senders, which no client role can touch --
-- it exists only so a service-role operator can moderate. Each user gets one
-- random Halloween alias (group_chat_aliases), assigned server-side on first
-- use. The Drake bot is the exception by design: the service role posts as
-- alias 'prosecco_daddy', which the alias generator can never produce.
--
-- Clients cannot insert directly; they call halloween_send(), which stamps the
-- caller's own alias, so nobody can post under someone else's name.
--
-- Safe to re-run, and supersedes the first draft of this migration.
-- =============================================================================

drop function if exists public.halloween_send(text);
drop table if exists public.group_chat_senders cascade;
drop table if exists public.group_chat_messages cascade;
drop table if exists public.group_chat_aliases cascade;
drop function if exists public.halloween_in_chat();

-- People kept out of the room. Keyed by username, resolved at call time, so an
-- account that signs up later under one of these names is excluded too.
create table if not exists public.group_chat_excluded (
  username text primary key
);
alter table public.group_chat_excluded enable row level security;
revoke all on public.group_chat_excluded from anon, authenticated;
grant all on public.group_chat_excluded to service_role;
insert into public.group_chat_excluded (username)
values ('luliakl'), ('brynna'), ('golder_girl1'), ('ccmel'), ('._.')
on conflict do nothing;

create table public.group_chat_aliases (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  alias   text not null unique
);

create table public.group_chat_messages (
  id         uuid primary key default gen_random_uuid(),
  room       text not null check (room = 'halloween-2026'),
  alias      text not null,
  body       text not null check (length(body) <= 1000),
  -- A photo message: the object name in the halloween-chat bucket (a bare
  -- random uuid -- never a user id, which would undo the anonymity) plus its
  -- pixel size so the list can reserve the right height before it loads.
  image_path text check (image_path ~ '^[0-9a-f-]{36}\.jpg$'),
  image_w    int  check (image_w between 1 and 4096),
  image_h    int  check (image_h between 1 and 4096),
  created_at timestamptz not null default now(),
  check (length(btrim(body)) > 0 or image_path is not null),
  check ((image_path is null) = (image_w is null) and (image_path is null) = (image_h is null))
);

create index group_chat_messages_room_idx
  on public.group_chat_messages (room, created_at);

create table public.group_chat_senders (
  message_id uuid primary key references public.group_chat_messages (id) on delete cascade,
  sender_id  uuid not null references public.profiles (id) on delete cascade
);

alter table public.group_chat_aliases  enable row level security;
alter table public.group_chat_messages enable row level security;
alter table public.group_chat_senders  enable row level security;

-- True for a signed-in user who is not on the exclusion list. Security definer
-- so clients never need (or get) read access to the list itself.
create or replace function public.halloween_in_chat()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (select auth.uid()) is not null
    and not exists (
      select 1
      from public.profiles p
      join public.group_chat_excluded e on lower(e.username) = lower(p.username)
      where p.id = (select auth.uid())
    );
$$;
revoke all on function public.halloween_in_chat() from public;
grant execute on function public.halloween_in_chat() to authenticated, service_role;

create policy group_chat_select
  on public.group_chat_messages for select
  to authenticated
  using (public.halloween_in_chat());

revoke all on public.group_chat_aliases, public.group_chat_messages, public.group_chat_senders
  from anon, authenticated;
grant select on public.group_chat_messages to authenticated;
grant all on public.group_chat_aliases, public.group_chat_messages, public.group_chat_senders
  to service_role;

-- The caller's alias, assigned at random (and permanently) on first call.
create or replace function public.halloween_my_alias()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid   uuid := (select auth.uid());
  adjs  text[] := array[
    'Soggy','Sleepy','Haunted','Unemployed','Mildly Cursed','Overdue','Crunchy',
    'Suspicious','Damp','Emotional','Bargain-Bin','Gluten-Free','Fashionably Late',
    'Lactose-Intolerant','Unpaid','Chronically Online','Slightly Toasted','Feral',
    'Sentient','Budget','Over-Caffeinated','Politely Haunting','Dramatic','Expired'
  ];
  nouns text[] := array[
    'Skeleton','Ghost','Pumpkin','Vampire','Zombie','Witch','Werewolf','Mummy',
    'Cauldron','Candy Corn','Bat','Black Cat','Scarecrow','Goblin','Gravedigger',
    'Ghoul','Spider','Candle','Fun-Size Snickers','Fortune Teller'
  ];
  a     text;
  tries int := 0;
begin
  if uid is null then
    raise exception 'not signed in';
  end if;
  if not public.halloween_in_chat() then
    return null;
  end if;

  select alias into a from public.group_chat_aliases where user_id = uid;
  if a is not null then
    return a;
  end if;

  loop
    tries := tries + 1;
    a := adjs[1 + floor(random() * array_length(adjs, 1))::int] || ' '
      || nouns[1 + floor(random() * array_length(nouns, 1))::int];
    begin
      insert into public.group_chat_aliases (user_id, alias) values (uid, a);
      return a;
    exception when unique_violation then
      -- Either a concurrent call already gave this user one, or the alias is
      -- taken by someone else. Return the former, retry on the latter.
      select alias into a from public.group_chat_aliases where user_id = uid;
      if a is not null then
        return a;
      end if;
      if tries > 200 then
        raise exception 'could not assign an alias';
      end if;
    end;
  end loop;
end;
$$;

create or replace function public.halloween_send(
  msg   text,
  img   text default null,
  img_w int  default null,
  img_h int  default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid uuid := (select auth.uid());
  mid uuid;
begin
  if uid is null then
    raise exception 'not signed in';
  end if;
  if not public.halloween_in_chat() then
    raise exception 'not in this chat';
  end if;
  insert into public.group_chat_messages (room, alias, body, image_path, image_w, image_h)
  values ('halloween-2026', public.halloween_my_alias(), coalesce(msg, ''), img, img_w, img_h)
  returning id into mid;
  insert into public.group_chat_senders (message_id, sender_id) values (mid, uid);
end;
$$;

revoke all on function public.halloween_my_alias() from public;
revoke all on function public.halloween_send(text, text, int, int) from public;
grant execute on function public.halloween_my_alias() to authenticated, service_role;
grant execute on function public.halloween_send(text, text, int, int) to authenticated, service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_chat_messages'
  ) then
    alter publication supabase_realtime add table public.group_chat_messages;
  end if;
end $$;

-- Photos. Public bucket so <Image> can load a URL; there is deliberately NO
-- select policy on storage.objects for it, so nobody can list the bucket or
-- read an object's uploader (storage.objects.owner) -- only fetch a URL they
-- were given. Anyone signed in can add a small JPEG; that is all.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('halloween-chat', 'halloween-chat', true, 5242880, array['image/jpeg'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  drop policy if exists "halloween chat insert" on storage.objects;
  create policy "halloween chat insert"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'halloween-chat');
exception
  when insufficient_privilege then
    raise notice 'Could not manage policies on storage.objects. Create an INSERT policy for authenticated on bucket halloween-chat from the Dashboard instead.';
end
$$;
