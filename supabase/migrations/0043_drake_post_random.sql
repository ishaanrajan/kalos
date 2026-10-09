-- =============================================================================
-- 0043_drake_post_random.sql
--
-- Drake posts three times a week instead of every day, on days nobody can
-- predict. He was 13 of the 51 posts on the app over the fortnight to
-- 2026-10-08 -- a quarter of the whole feed from one account out of 48, and
-- about sixteen times the rate of an average real user.
--
-- A fixed '* * 1,3,5' would be three a week but it would also be the same
-- three days forever, which is the opposite of what was asked for. So this
-- follows the pattern drake-comment already uses (0026): tick often, flip a
-- coin, and put hard ceilings underneath so the randomness can't run away.
--
--   '0 * * * *'    an hourly tick, so the hour of day is unpredictable too
--   random() < .08 the coin
--   48h floor      he can never post two days running
--   3 per 7 days   hard ceiling; the coin alone must never beat it
--
-- Simulated over 1200 weeks: mean 2.67 posts/week, 67% of weeks land exactly
-- 3 and 32% land 2, never 4 or more, never 0, median gap 2.5 days. Raising
-- the coin tightens it toward 3 but makes it bursty -- the ceiling then binds
-- early and he posts three times in two days and nothing for five. The 48h
-- floor is what keeps the three spread out, and it matters more than hitting
-- exactly three.
--
-- Renamed from 'daily-drake-post', which is no longer true. Unschedule then
-- schedule, same as 0042: if the second statement fails he goes quiet, which
-- is the safe direction here.
--
-- Note for whoever reads daily-drake/index.ts next: its avatar swap is gated
-- on "every 3rd post", which used to mean every 3 days and now means roughly
-- once a week. That's consistent with toning him down, so it's left alone.
-- =============================================================================

do $$
begin
  if exists (select 1 from cron.job where jobname = 'daily-drake-post') then
    perform cron.unschedule('daily-drake-post');
  end if;
end $$;

select cron.schedule(
  'drake-post-random',
  '0 * * * *',
  $$
  select net.http_post(
    url := 'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/daily-drake',
    headers := '{"Content-Type": "application/json"}'::jsonb
  )
  where random() < 0.08
    and not exists (
      select 1
      from public.posts
      where author_id = (select id from public.profiles where username = 'prosecco_daddy')
        and created_at > now() - interval '48 hours'
    )
    and (
      select count(*)
      from public.posts
      where author_id = (select id from public.profiles where username = 'prosecco_daddy')
        and created_at > now() - interval '7 days'
    ) < 3;
  $$
);
