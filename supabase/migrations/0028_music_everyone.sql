-- =============================================================================
-- 0028_music_everyone.sql
--
-- Repeals 0025_music_ishaan_only.sql. Music posting was restricted to one
-- account while the feature was being dialed in; that period is over, so
-- posts_insert_own goes back to the plain ownership check from 0004_rls.sql
-- with no carve-out on `music`. Listening was never restricted (0024/0025
-- both left home_feed/explore_feed author-agnostic), so this is purely about
-- who can attach a track when posting.
-- =============================================================================

drop policy if exists posts_insert_own on public.posts;
create policy posts_insert_own
  on public.posts for insert
  to authenticated
  with check (author_id = (select auth.uid()));
