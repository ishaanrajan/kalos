-- =============================================================================
-- 0032_fix_post_blocked_permission.sql
--
-- post_blocked() (0031_post_blocks.sql) was a plain function, not security
-- definer -- so it ran with the CALLING role's own privileges, and since
-- post_blocks deliberately has no grant to authenticated (a blocked account
-- shouldn't be able to read whether it's blocked), every single call threw
-- "permission denied for table post_blocks" instead of returning true/false.
-- That's not just "blocking didn't work" -- it broke `posts_select_authenticated`
-- outright, since that policy's `using` clause calls this function for every
-- row: nobody but the service role could select from posts at all until this
-- is applied. verify-post-blocks.ts caught it immediately.
--
-- security definer makes the function's internal query run as its owner
-- instead, the same reason home_feed()/explore_feed() already need it to
-- read tables the calling role can't see directly.
-- =============================================================================

create or replace function public.post_blocked(author uuid, viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.post_blocks
    where blocker_id = author and blocked_id = viewer
  );
$$;

revoke all on function public.post_blocked(uuid, uuid) from public;
grant execute on function public.post_blocked(uuid, uuid) to authenticated, service_role;
