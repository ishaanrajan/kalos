-- =============================================================================
-- 0010_onboarding.sql
--
-- New accounts are walked through adding a profile photo and sharing a first
-- post before they reach the rest of the app -- existing accounts are never
-- retroactively forced into this, which is what profiles.onboarded is for:
-- it defaults to true (every row that already exists is left alone), and
-- handle_new_user() is the only thing that ever inserts a row with it false.
-- The client flips it back to true once both steps are done.
-- =============================================================================

alter table public.profiles add column if not exists onboarded boolean not null default true;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  requested text;
  base      text;
  candidate text;
  n         int := 0;
begin
  requested := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'username'), ''),
    split_part(coalesce(new.email, ''), '@', 1)
  );

  base := regexp_replace(lower(coalesce(requested, '')), '[^a-z0-9._]', '', 'g');
  if length(base) < 3 then
    base := 'user' || replace(substr(new.id::text, 1, 8), '-', '');
  end if;
  base := substr(base, 1, 30);

  candidate := base;
  while exists (select 1 from public.profiles p where p.username = candidate::citext) loop
    n := n + 1;
    candidate := substr(base, 1, greatest(1, 30 - (length(n::text) + 1))) || '_' || n::text;
  end loop;

  insert into public.profiles (id, username, display_name, avatar_path, bio, onboarded)
  values (
    new.id,
    candidate,
    nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'avatar_path'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'bio'), ''),
    false
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

grant update (username, display_name, bio, avatar_path, activity_read_at, onboarded)
  on public.profiles to authenticated;
