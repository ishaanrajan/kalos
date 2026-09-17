-- =============================================================================
-- 0035_edit_post_music.sql
--
-- Supersedes the decision documented in 0024_post_music.sql: "the song is
-- chosen at capture time like the filter is, and post-hoc editing is not
-- part of this feature." It's being asked for, and there's no reason left
-- to refuse it -- adding, changing, or removing a post's music is exactly
-- the same write the composer already makes (a jsonb object satisfying
-- posts_music_shape, or null), just from a different screen after the fact.
--
-- posts_update_own (0004_rls.sql) already scopes any update to the post's
-- own author; the column-level grant is the only thing that was narrower
-- than that. Nothing else changes: posts_music_shape (0024) still rejects
-- a half-built object regardless of which screen is writing it.
-- =============================================================================

grant update (music) on public.posts to authenticated;
