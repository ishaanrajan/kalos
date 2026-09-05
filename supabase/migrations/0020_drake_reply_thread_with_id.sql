-- =============================================================================
-- 0020_drake_reply_thread_with_id.sql
--
-- Bug fix: drake_pending_replies only stored thread_user_id, and
-- drake-reply-flush hardcoded thread_with_id = the bot's own id when sending
-- the actual reply -- correct for a regular user's thread with Drake
-- (thread_user_id = them, thread_with_id = drake), but wrong for ishaan's:
-- his DM screen always puts *himself* in thread_with_id regardless of who
-- he's talking to (that's how his cross-user inbox is built), so HIS thread
-- with Drake is (thread_user_id = drake, thread_with_id = ishaan). Every
-- message ishaan sent to Drake was invisible to drake-reply-generate (it
-- only checked thread_with_id === bot.id), and even once generated, a reply
-- would have landed in a thread keyed to the bot's own id that nothing
-- reads. Storing the real thread_with_id from the original message fixes
-- both: drake-reply-generate now preserves whichever slot Drake was
-- actually in, and drake-reply-flush reuses that exact pair when sending.
-- =============================================================================

alter table public.drake_pending_replies
  add column if not exists thread_with_id uuid references public.profiles (id) on delete cascade;

-- Existing rows (if any) predate this fix and have no way to know their real
-- thread_with_id -- there should be none live given the table is a
-- short-lived work queue, but backfill to the bot's own id (the assumption
-- the old code always made) rather than leave a NULL that'd violate the
-- not-null constraint being added next.
update public.drake_pending_replies
   set thread_with_id = (select id from public.profiles where username = 'prosecco_daddy')
 where thread_with_id is null;

alter table public.drake_pending_replies
  alter column thread_with_id set not null;
