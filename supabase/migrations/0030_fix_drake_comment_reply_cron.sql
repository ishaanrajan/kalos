-- =============================================================================
-- 0030_fix_drake_comment_reply_cron.sql
--
-- drake-comment-reply-flush-every-minute (0026_drake_comments.sql) stopped
-- running -- two queued replies sat in drake_pending_comment_replies for
-- 6-9 hours past their send_at with nothing flushing them, while the
-- sibling jobs (drake-dm every 4h, drake-comment-hourly-check hourly) kept
-- firing normally on schedule the whole time. Manually invoking the
-- drake-comment-reply-flush function directly worked instantly and drained
-- the backlog, so the function itself is fine -- only this one pg_cron
-- registration was missing/broken.
--
-- cron.schedule() with an existing job name reschedules it in place rather
-- than erroring, so simply re-running it is enough to fix this regardless
-- of whether the job was silently dropped, never created, or misconfigured
-- -- no need to pin down which.
-- =============================================================================

select cron.schedule(
  'drake-comment-reply-flush-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/drake-comment-reply-flush',
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  $$
);
