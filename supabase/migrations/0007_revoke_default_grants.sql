-- ---------------------------------------------------------------------------
-- 0007  Revoke Supabase's default blanket grants, then re-apply ours.
-- ---------------------------------------------------------------------------
-- Migration 0004 granted UPDATE per column, so that the trigger-maintained
-- counters (like_count, comment_count, post_count, follower_count,
-- following_count) could not be written by a client:
--
--     grant update (caption, filter_name) on public.posts to authenticated;
--
-- That grant was correct but inert. Supabase ships a default privilege on the
-- `public` schema that grants ALL on every new table to anon and authenticated.
-- A column-level GRANT only adds privileges -- it cannot subtract the
-- table-level UPDATE that was already there. The net effect was that any signed
-- in user could set like_count on their own post to any number they liked:
--
--     await supabase.from('posts').update({ like_count: 99999 }).eq('id', mine)
--     -> succeeded
--
-- Nothing in this app orders by like_count, so a forged counter could not buy
-- reach -- which is the whole point of the schema. But a number displayed as a
-- fact should be a fact, so: revoke everything from the client roles first,
-- then grant back exactly what the app needs.
--
-- RLS still does the row filtering. These grants decide which *columns and
-- verbs* are reachable at all, before any policy is consulted.

revoke all on public.profiles from anon, authenticated;
revoke all on public.posts    from anon, authenticated;
revoke all on public.follows  from anon, authenticated;
revoke all on public.likes    from anon, authenticated;
revoke all on public.comments from anon, authenticated;

-- Stop the default privilege from re-granting ALL on tables added later.
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- Re-apply 0004's intent. `anon` gets nothing: every screen in the app requires
-- a session, and the profile-bootstrap trigger runs as security definer.
grant select, insert, delete on public.profiles to authenticated;
grant select, insert, delete on public.posts    to authenticated;
grant select, insert, delete on public.follows  to authenticated;
grant select, insert, delete on public.likes    to authenticated;
grant select, insert, delete on public.comments to authenticated;

grant update (username, display_name, bio, avatar_path) on public.profiles to authenticated;
grant update (caption, filter_name)                     on public.posts    to authenticated;

grant all on public.profiles, public.posts, public.follows, public.likes, public.comments
  to service_role;
