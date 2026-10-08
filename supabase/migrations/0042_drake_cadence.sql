-- =============================================================================
-- 0042_drake_cadence.sql
--
-- Drake was out-talking the humans. Measured over the fourteen days to
-- 2026-10-08: 38 human posts (2.7/day) against 198 DMs from @prosecco_daddy.
-- Roughly half of those DMs were two one-off manual blasts, but the cron alone
-- accounted for 6 a day -- more than twice the rate at which actual people
-- posted anything. Add the daily photo and the hourly comment check and the
-- bot's unsolicited output ran to ~8 things a day against the humans' 2.7.
--
-- Two changes, both to the DM job:
--
--   1. Once a day instead of every four hours (6/day -> 1/day). Combined with
--      the comment job's existing hard ceiling of 1/day, that puts Drake's
--      unsolicited chatter at no more than 2/day against a human baseline of
--      ~2.7 posts/day.
--
--   2. The HTTP call is now gated on a human having posted in the last 24
--      hours. A rate that merely *averages* below the humans still out-talks
--      them on a quiet week, and a bot DMing into a dead app is exactly the
--      engagement-bait reflex this whole project is a reaction against. No
--      human posts, no Drake DM. `select ... where exists (...)` evaluates the
--      target list only if the qual passes, so net.http_post genuinely does
--      not fire.
--
-- The reactive jobs are deliberately untouched: drake-reply-flush and
-- drake-comment-reply-flush only ever answer someone who addressed Drake
-- first, and a bot that ignores a direct message is broken, not polite.
--
-- Renames the job, since 'drake-dm-every-4h' would now be a lie. Unschedule
-- first, then schedule: if the second statement fails the bot goes quiet,
-- which is the safe direction for a change whose whole purpose is less.
-- =============================================================================

do $$
begin
  if exists (select 1 from cron.job where jobname = 'drake-dm-every-4h') then
    perform cron.unschedule('drake-dm-every-4h');
  end if;
end $$;

-- 0 17 * * * = 17:00 UTC daily (~11am Mountain). Deliberately not 15:30, which
-- is when daily-drake-post fires -- a photo and a DM landing in the same
-- minute reads as a bot doing its rounds.
select cron.schedule(
  'drake-dm-daily',
  '0 17 * * *',
  $$
  select net.http_post(
    url := 'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/drake-dm',
    headers := '{"Content-Type": "application/json"}'::jsonb
  )
  where exists (
    select 1
    from public.posts p
    where p.created_at > now() - interval '24 hours'
      and p.author_id <> (select id from public.profiles where username = 'prosecco_daddy')
  );
  $$
);
