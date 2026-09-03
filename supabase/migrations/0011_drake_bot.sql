-- Daily cron schedule for the daily-drake Edge Function (see
-- supabase/functions/daily-drake/index.ts). Requires, in order:
--
--   1. `pg_net`  extension enabled -- should already be on from 0009_notifications.sql.
--   2. `pg_cron` extension enabled -- Dashboard -> Database -> Extensions.
--      If this file fails with `schema "cron" does not exist`, that's why:
--      enable it there first, same friction pg_net hit earlier.
--   3. The `daily-drake` function deployed via Dashboard -> Edge Functions
--      (see supabase/README.md's "Push notifications" section for the same
--      deploy flow, just a different function name), with "Enforce JWT
--      verification" turned OFF -- pg_cron calls it the same way a Database
--      Webhook does, with no user JWT to attach.
--
-- `cron.schedule(job_name, ...)` upserts by name, so re-running this file
-- after a schedule tweak is safe -- it updates the existing job in place
-- rather than creating a duplicate.
--
-- 30 15 * * * = 15:30 UTC daily, ~9:30am Mountain (MDT, UTC-6) / 8:30am
-- Mountain standard time in winter. Change the cron expression below if a
-- different time is wanted.

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
