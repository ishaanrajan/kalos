-- Ishaan appears as himself in the Halloween chat. Function-only, so applying
-- it keeps existing messages (unlike re-running 0047).

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

  -- The owner appears as himself. The generator only makes "Adjective Noun"
  -- pairs, so 'ishaan' can never collide with a random alias.
  if exists (select 1 from public.profiles where id = uid and lower(username) = 'ishaan') then
    insert into public.group_chat_aliases (user_id, alias) values (uid, 'ishaan')
    on conflict (user_id) do update set alias = 'ishaan';
    return 'ishaan';
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

grant execute on function public.halloween_my_alias() to authenticated, service_role;
