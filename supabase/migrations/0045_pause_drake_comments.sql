-- =============================================================================
-- 0045_pause_drake_comments.sql
--
-- Pauses @prosecco_daddy's unsolicited commenting. Deactivated rather than
-- unscheduled, so the schedule and command survive and turning it back on is
-- one statement (at the bottom of this file) rather than a re-run of 0026.
--
-- Why: over the seven days to 2026-10-18 Drake posted 4 comments against the
-- humans' 4 -- half of every comment on the app came from the bot. 0044 left
-- this job alone on the reasoning that it was "already proportional by
-- construction" because it only comments on today's posts and caps itself at
-- one a day. That reasoning was wrong: commenting on today's posts only
-- requires that *one* post exist today, so the cap was the only thing binding
-- and 1/day is far too much when the humans manage 4 comments a week.
--
-- Two things to fix before this is switched back on, neither of which is the
-- cron's business:
--
--   1. Frequency. The ceiling should track human comment volume the way
--      0044 made posting track human post volume -- something like
--      drake_comments_7d < least(2, human_comments_7d / 3), which lands him
--      near 1/week at current activity instead of 4.
--
--   2. Repetition, which is probably what actually made it grating. The pool
--      in drake-comment/index.ts is 14 lines picked uniformly at random with
--      no memory, so lines recur fast: of the 10 comments deleted alongside
--      this migration, "no cap, certified banger, no notes" appeared 3 times
--      and "certified lover boy behavior, dropping into your comments
--      unannounced" twice, two days apart. The function already refuses to
--      comment on the same post twice by querying its own prior comments
--      rather than keeping a log table -- the same trick works on bodies, so
--      excluding recently-used lines needs no new schema, just a filter on
--      the pick.
--
-- drake-comment-reply-flush is deliberately left running: it only answers
-- someone who @-mentioned Drake first, and a bot that ignores you when you
-- talk to it is broken rather than quiet. None of the 10 deleted comments
-- were replies -- they were all unprompted one-liners.
-- =============================================================================

do $$
declare
  jid bigint;
begin
  select jobid into jid from cron.job where jobname = 'drake-comment-hourly-check';
  if jid is null then
    raise notice 'drake-comment-hourly-check is not registered; nothing to pause';
  else
    perform cron.alter_job(job_id := jid, active := false);
  end if;
end $$;

-- To resume (ideally after the two fixes above):
--
--   do $$
--   declare jid bigint;
--   begin
--     select jobid into jid from cron.job where jobname = 'drake-comment-hourly-check';
--     perform cron.alter_job(job_id := jid, active := true);
--   end $$;
