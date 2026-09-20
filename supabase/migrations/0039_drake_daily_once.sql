-- =============================================================================
-- 0039_drake_daily_once.sql
--
-- Cuts the daily-drake cron (0011_drake_bot.sql) from twice a day down to
-- once. Keeps the 15:30 UTC slot (~9:30am Mountain) and drops the 03:30 UTC
-- one -- a single morning post reads more like a real person than two posts
-- roughly twelve hours apart.
--
-- cron.schedule(job_name, ...) upserts by name, so this updates the existing
-- 'daily-drake-post' job in place rather than creating a second one --
-- same mechanism 0030_fix_drake_comment_reply_cron.sql relied on.
-- =============================================================================

select cron.schedule(
  'daily-drake-post',
  '30 15 * * *',
  $$
  select net.http_post(
    url := 'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/daily-drake',
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  $$
);
