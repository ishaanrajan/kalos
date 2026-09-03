-- Cron schedule for the drake-dm Edge Function (see
-- supabase/functions/drake-dm/index.ts). Same prerequisites as
-- 0011_drake_bot.sql -- pg_net and pg_cron should already be enabled by now,
-- so this is just the new job:
--
--   The `drake-dm` function deployed via Dashboard -> Edge Functions, with
--   "Enforce JWT verification" turned OFF -- pg_cron calls it the same way a
--   Database Webhook does, with no user JWT to attach.
--
-- `cron.schedule(job_name, ...)` upserts by name, so re-running this file
-- after a schedule tweak is safe.
--
-- 0 */4 * * * = every 4 hours on the hour (00:00, 04:00, 08:00, 12:00,
-- 16:00, 20:00 UTC).

select cron.schedule(
  'drake-dm-every-4h',
  '0 */4 * * *',
  $$
  select net.http_post(
    url := 'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/drake-dm',
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  $$
);
