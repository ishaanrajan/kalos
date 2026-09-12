-- =============================================================================
-- 0025_music_ishaan_only.sql
--
-- Posting with music is ishaan-only; everyone else can still hear it in the
-- feed (0024_post_music.sql put no restriction on listening, and none is
-- added here -- home_feed/explore_feed return `music` for every post
-- regardless of author).
--
-- The composer hides the "Add music" entry point from everyone but ishaan
-- (app/(tabs)/new.tsx), but that's a UX gate, not a boundary -- a client-side
-- check never stops a handwritten insert. `music` is insert-only (0024 grants
-- no `update (music)`), so the one place to actually enforce this is
-- posts_insert_own's own `with check`, the same way 0008_dm.sql lets ishaan,
-- and only ishaan, write into someone else's DM thread.
-- =============================================================================

drop policy if exists posts_insert_own on public.posts;
create policy posts_insert_own
  on public.posts for insert
  to authenticated
  with check (
    author_id = (select auth.uid())
    and (music is null or author_id = public.ishaan_id())
  );
