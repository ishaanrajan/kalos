import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { PHOTOS_BUCKET, supabase } from './supabase';
import { searchTracks } from './music';
import { searchGifs } from './giphy';
import { useAuth, useUserId } from './auth';
import {
  PAGE_SIZE,
  type ActivityEvent,
  type Comment,
  type CommentGif,
  type DMMessage,
  type DMThreadSummary,
  type FeedPost,
  type PostTag,
  type Profile,
} from './types';

/**
 * Every list in this app is strictly reverse-chronological and paginated by
 * keyset on (created_at, id). No offsets — offsets skip and duplicate rows when
 * new posts land mid-scroll — and no ranking, ever.
 */
function cursorFrom(page: FeedPost[]) {
  const last = page.at(-1);
  if (!last) return undefined;
  return { before: last.created_at, before_id: last.id };
}

type Cursor = { before: string; before_id: string } | undefined;

function feedQuery(fn: 'home_feed' | 'explore_feed', userId: string | null) {
  return {
    queryKey: [fn, userId] as const,
    initialPageParam: undefined as Cursor,
    enabled: !!userId,
    queryFn: async ({ pageParam }: { pageParam: Cursor }) => {
      const { data, error } = await supabase.rpc(fn, {
        before: pageParam?.before ?? null,
        before_id: pageParam?.before_id ?? null,
        lim: PAGE_SIZE,
      });
      if (error) throw error;
      return (data ?? []) as FeedPost[];
    },
    // A short page means we've reached the end. That's the whole point: the
    // feed terminates instead of backfilling with strangers.
    getNextPageParam: (lastPage: FeedPost[]) =>
      lastPage.length < PAGE_SIZE ? undefined : cursorFrom(lastPage),
  };
}

export function useHomeFeed() {
  return useInfiniteQuery(feedQuery('home_feed', useUserId()));
}

export function useExploreFeed() {
  return useInfiniteQuery(feedQuery('explore_feed', useUserId()));
}

/**
 * Pull-to-refresh for an infinite feed. A bare refetch() on an infinite
 * query re-fetches every loaded page in series (page 2's cursor comes from
 * the refetched page 1, and so on), so six pages deep the spinner sat
 * through six round trips and the whole list swapped at once at the end.
 * Trim the cache to page 1 first and refetch just that -- the pages below
 * reload on scroll like they did the first time.
 */
export function useRefreshFeed(fn: 'home_feed' | 'explore_feed') {
  const qc = useQueryClient();
  const userId = useUserId();
  return useCallback(async () => {
    const queryKey = [fn, userId] as const;
    qc.setQueryData<InfiniteData<FeedPost[], Cursor>>(queryKey, (data) =>
      data && data.pages.length > 1
        ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
        : data
    );
    await qc.refetchQueries({ queryKey, exact: true });
  }, [qc, fn, userId]);
}

/**
 * Patch one post wherever a cached copy of it lives -- every page of both
 * feeds, the profile grid, and the single-post entry. Used for the counters
 * a mutation already knows the answer to (likes, comments), so the card
 * updates in place instead of sitting wrong until the next full refetch.
 */
function patchCachedPost(
  qc: ReturnType<typeof useQueryClient>,
  postId: string,
  patch: (p: FeedPost) => FeedPost
): [readonly unknown[], unknown][] {
  const feedSnapshots = qc
    .getQueriesData<InfiniteData<FeedPost[]>>({ queryKey: ['home_feed'] })
    .concat(qc.getQueriesData<InfiniteData<FeedPost[]>>({ queryKey: ['explore_feed'] }));
  for (const [key, value] of feedSnapshots) {
    if (!value) continue;
    qc.setQueryData<InfiniteData<FeedPost[]>>(key, {
      ...value,
      pages: value.pages.map((page) => page.map((p) => (p.id === postId ? patch(p) : p))),
    });
  }

  const listSnapshots = qc.getQueriesData<FeedPost[]>({ queryKey: ['profile-posts'] });
  for (const [key, value] of listSnapshots) {
    if (!value) continue;
    qc.setQueryData<FeedPost[]>(key, value.map((p) => (p.id === postId ? patch(p) : p)));
  }

  // The single-post screen (app/post/[id].tsx) isn't an infinite-query
  // page, it's one `['post', postId, userId]` entry.
  const postSnapshots = qc.getQueriesData<FeedPost>({ queryKey: ['post', postId] });
  for (const [key, value] of postSnapshots) {
    if (!value) continue;
    qc.setQueryData(key, patch(value));
  }

  return [...feedSnapshots, ...listSnapshots, ...postSnapshots] as [readonly unknown[], unknown][];
}

export function useActivity() {
  const userId = useUserId();
  return useQuery({
    queryKey: ['activity', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('activity_feed', { lim: 50 });
      if (error) throw error;
      return (data ?? []) as ActivityEvent[];
    },
    // useHasUnreadActivity() derives its badge from this -- it needs to
    // catch up the moment you return to the app, not wait out staleTime.
    refetchOnWindowFocus: true,
  });
}

/**
 * Whether a query failure means "that row doesn't exist" rather than "the
 * request didn't get through". PostgREST's .single() on zero rows fails with
 * PGRST116; anything else -- a tunnel, a 500, an expired token -- is not
 * evidence the account is gone, and used to be reported as exactly that.
 */
export function isNotFoundError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: string }).code === 'PGRST116';
}

export function useProfile(username: string | undefined) {
  return useQuery({
    queryKey: ['profile', username],
    enabled: !!username,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('username', username!)
        .single();
      if (error) throw error;
      return data as Profile;
    },
  });
}

export function useProfilePosts(profileId: string | undefined) {
  return useQuery({
    queryKey: ['profile-posts', profileId],
    enabled: !!profileId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('posts')
        .select('*')
        .eq('author_id', profileId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as FeedPost[];
    },
  });
}

/**
 * The single-post / comments screen. This is a raw table query, not one of
 * the feed RPCs, so `viewer_has_liked` isn't a real column on `posts` --
 * it has to be fetched separately (a plain `likes` row lookup, same table
 * `useToggleLike` itself writes to) and merged in. Without this, the heart
 * on this screen would always read as "not liked", and `onLike` would always
 * try to INSERT a like that may already exist.
 */
export function usePost(postId: string | undefined) {
  const userId = useUserId();
  return useQuery({
    queryKey: ['post', postId, userId],
    enabled: !!postId,
    queryFn: async () => {
      const [postResult, likeResult, tagsResult] = await Promise.all([
        supabase
          .from('posts')
          .select('*, author:profiles!posts_author_id_fkey(id, username, display_name, avatar_path)')
          .eq('id', postId!)
          .single(),
        userId
          ? supabase.from('likes').select('post_id').eq('post_id', postId!).eq('user_id', userId).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        // Its own query rather than an embed on the posts select: an embed
        // fails the whole screen against a database where 0034 hasn't run,
        // where this just comes back empty. (RLS on post_tags defers to the
        // post's own visibility, so nothing extra to check here.)
        supabase
          .from('post_tags')
          .select('user_id, x, y, user:profiles!post_tags_user_id_fkey(username)')
          .eq('post_id', postId!)
          .order('created_at', { ascending: true }),
      ]);
      if (postResult.error) throw postResult.error;
      if (likeResult.error) throw likeResult.error;
      return {
        ...postResult.data,
        viewer_has_liked: !!likeResult.data,
        tags: tagsResult.error ? undefined : normalizeTags(tagsResult.data),
      } as FeedPost & { author: Pick<Profile, 'id' | 'username' | 'display_name' | 'avatar_path'> };
    },
  });
}

/**
 * Tags arrive in two shapes: the feed RPCs build `{user_id, username, x, y}`
 * directly, while a PostgREST embed nests the username under `user`. One
 * shape leaves this file. Anything that isn't an array (a database without
 * 0034 yet) resolves to undefined, which every consumer treats as "no tags".
 */
function normalizeTags(raw: unknown): PostTag[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tags: PostTag[] = [];
  for (const row of raw as Array<Record<string, unknown>>) {
    const userId = row.user_id;
    const nested = row.user as { username?: unknown } | null | undefined;
    const username = typeof row.username === 'string' ? row.username : nested?.username;
    const x = Number(row.x);
    const y = Number(row.y);
    if (typeof userId !== 'string' || typeof username !== 'string') continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    tags.push({ user_id: userId, username, x, y });
  }
  return tags;
}

/**
 * Posts this account is tagged on -- the profile's "Photos of you" grid.
 * post_tags' select policy only shows a row when the post itself is visible
 * to the viewer, so an account the author has hidden their posts from
 * (post_blocks) sees neither the tag nor the post here.
 */
export function useTaggedPosts(profileId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['tagged-posts', profileId],
    enabled: !!profileId && enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('post_tags')
        .select('created_at, post:posts!post_tags_post_id_fkey(*)')
        .eq('user_id', profileId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? [])
        .map((row) => row.post as unknown as FeedPost | null)
        .filter((post): post is FeedPost => !!post);
    },
  });
}

export function useComments(postId: string | undefined) {
  return useQuery({
    queryKey: ['comments', postId],
    enabled: !!postId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('comments')
        .select('*, author:profiles!comments_author_id_fkey(id, username, avatar_path)')
        .eq('post_id', postId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data as Comment[];
    },
  });
}

/**
 * After a comment lands, the feed card has to agree with the thread: its
 * "View all N comments" line and two-line preview come from the cached
 * FeedPost, and the tab screens stay mounted with refetchOnWindowFocus off,
 * so invalidating only ['comments'] and ['post'] left both wrong until a
 * pull-to-refresh. The mutation knows the answer, so write it into place
 * the way useToggleLike does. preview_comments is the 2 most recent,
 * oldest first, matching home_feed()'s jsonb_agg.
 */
function applyNewComment(
  qc: ReturnType<typeof useQueryClient>,
  postId: string,
  preview: { id: string; username: string; body: string }
) {
  patchCachedPost(qc, postId, (p) => ({
    ...p,
    comment_count: p.comment_count + 1,
    preview_comments: p.preview_comments
      ? [...p.preview_comments, preview].slice(-2)
      : p.preview_comments,
  }));
  qc.invalidateQueries({ queryKey: ['comments', postId] });
  qc.invalidateQueries({ queryKey: ['post', postId] });
}

export function useAddComment(postId: string) {
  const qc = useQueryClient();
  const userId = useUserId();
  const { profile } = useAuth();
  return useMutation({
    mutationFn: async (body: string) => {
      const { data, error } = await supabase
        .from('comments')
        .insert({ post_id: postId, author_id: userId!, body })
        .select('id')
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (id, body) => {
      applyNewComment(qc, postId, { id, username: profile?.username ?? '', body });
    },
  });
}

/**
 * A GIF-only comment (0029_comment_gif.sql) -- a sibling to useAddComment
 * rather than a union on it. The composer's draft-trim/restore-on-failure
 * logic is tightly coupled to typed text and doesn't apply here (a failed
 * GIF send just needs a retry, there's no draft to give back), so keeping
 * the two mutations separate keeps both call sites simple.
 */
export function useAddGifComment(postId: string) {
  const qc = useQueryClient();
  const userId = useUserId();
  const { profile } = useAuth();
  return useMutation({
    mutationFn: async (gif: CommentGif) => {
      const { data, error } = await supabase
        .from('comments')
        .insert({ post_id: postId, author_id: userId!, body: null, gif })
        .select('id')
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (id) => {
      // '[GIF]' is what home_feed() itself coalesces a null body to.
      applyNewComment(qc, postId, { id, username: profile?.username ?? '', body: '[GIF]' });
    },
  });
}

/**
 * Likes are optimistic: the heart fills the instant you tap it, and every
 * cached copy of that post across the feed and explore lists is patched in
 * place so the UI never flickers back.
 */
export function useToggleLike() {
  const qc = useQueryClient();
  const userId = useUserId();

  return useMutation({
    mutationFn: async ({ postId, liked }: { postId: string; liked: boolean }) => {
      if (liked) {
        const { error } = await supabase
          .from('likes')
          .delete()
          .eq('post_id', postId)
          .eq('user_id', userId!);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('likes').insert({ post_id: postId, user_id: userId! });
        if (error) throw error;
      }
    },
    onMutate: async ({ postId, liked }) => {
      // Scoped on purpose. An unfiltered cancelQueries() matches *every* query
      // in the cache and cancels each one with revert:true, so tapping a heart
      // killed whatever else happened to be in flight -- most visibly the
      // feed's own fetchNextPage(): the footer spinner vanished, hasNextPage
      // stayed true, and because onEndReached had already fired for that
      // offset nothing loaded again until you scrolled up and back down. Same
      // shape of bug on the post screen, where liking mid-load left the
      // comment list empty. Cancel only the three key prefixes this mutation
      // actually writes to below -- those are the ones whose in-flight
      // responses could land after the optimistic patch and clobber it.
      await Promise.all([
        qc.cancelQueries({ queryKey: ['home_feed'] }),
        qc.cancelQueries({ queryKey: ['explore_feed'] }),
        qc.cancelQueries({ queryKey: ['profile-posts'] }),
        qc.cancelQueries({ queryKey: ['post', postId] }),
      ]);
      const snapshots = patchCachedPost(qc, postId, (p) => ({
        ...p,
        viewer_has_liked: !liked,
        like_count: p.like_count + (liked ? -1 : 1),
      }));
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      for (const [key, value] of ctx?.snapshots ?? []) qc.setQueryData(key, value);
    },
    onSettled: (_d, _e, { postId }) => {
      qc.invalidateQueries({ queryKey: ['post', postId] });
      // The likes screen is a separate list; without this, reopening it
      // within staleTime showed the pre-toggle set of people while the
      // card's own count had already moved.
      qc.invalidateQueries({ queryKey: ['likers', postId] });
    },
  });
}

export function useIsFollowing(profileId: string | undefined) {
  const userId = useUserId();
  return useQuery({
    queryKey: ['following', userId, profileId],
    enabled: !!userId && !!profileId && userId !== profileId,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('follows')
        .select('*', { count: 'exact', head: true })
        .eq('follower_id', userId!)
        .eq('followee_id', profileId!);
      if (error) throw error;
      return (count ?? 0) > 0;
    },
  });
}

/** The subset of a profile a list row needs. */
export type ProfileSummary = Pick<Profile, 'id' | 'username' | 'display_name' | 'avatar_path'>;

export type FollowListKind = 'followers' | 'following';

/**
 * The people behind the two counts on a profile.
 *
 * `follows` has two foreign keys into `profiles`, so which one to embed depends
 * on the direction being asked for: a follower is the *other* end of a row
 * pointing at you, someone you follow is the other end of a row pointing away.
 * Ordered newest-first, like everything else here.
 */
export function useFollowList(profileId: string | undefined, kind: FollowListKind) {
  return useQuery({
    queryKey: ['follow-list', kind, profileId],
    enabled: !!profileId,
    queryFn: async () => {
      const matchColumn = kind === 'followers' ? 'followee_id' : 'follower_id';
      const embed = kind === 'followers' ? 'follows_follower_id_fkey' : 'follows_followee_id_fkey';

      const { data, error } = await supabase
        .from('follows')
        .select(`created_at, profile:profiles!${embed}(id, username, display_name, avatar_path)`)
        .eq(matchColumn, profileId!)
        .order('created_at', { ascending: false });
      if (error) throw error;

      return (data ?? []).map((row) => row.profile) as unknown as ProfileSummary[];
    },
  });
}

export interface MutualFollowers {
  /** Up to 3, newest connection first -- enough to name two and count the rest. */
  people: ProfileSummary[];
  total: number;
}

/**
 * "Followed by X, Y and N others" on someone else's profile -- the
 * intersection of "people the viewer follows" and "people who follow this
 * profile". Two plain queries against `follows` (world-readable, see
 * 0004_rls.sql) rather than a database function: the first is just the
 * viewer's own following list, small at this app's scale; the second reuses
 * useFollowList's own embed pattern with `.in()` added to intersect against
 * it, and asks PostgREST for the exact total in the same request via
 * `{ count: 'exact' }` instead of a separate COUNT query.
 *
 * No backfill, same rule as suggested_profiles: a viewer who follows nobody
 * gets an empty result rather than a second query that would return nothing
 * anyway.
 */
export function useMutualFollowers(targetId: string | undefined) {
  const userId = useUserId();
  return useQuery({
    queryKey: ['mutual-followers', targetId, userId],
    // Never meaningful on your own profile -- follows_no_self means the
    // intersection is always empty there, but there's no reason to spend a
    // round trip confirming that.
    enabled: !!targetId && !!userId && targetId !== userId,
    queryFn: async (): Promise<MutualFollowers> => {
      const { data: mine, error: mineError } = await supabase
        .from('follows')
        .select('followee_id')
        .eq('follower_id', userId!);
      if (mineError) throw mineError;
      const followingIds = (mine ?? []).map((r) => r.followee_id);
      if (followingIds.length === 0) return { people: [], total: 0 };

      const { data, count, error } = await supabase
        .from('follows')
        .select('created_at, profile:profiles!follows_follower_id_fkey(id, username, display_name, avatar_path)', {
          count: 'exact',
        })
        .eq('followee_id', targetId!)
        .in('follower_id', followingIds)
        .order('created_at', { ascending: false })
        .limit(3);
      if (error) throw error;

      return {
        people: (data ?? []).map((row) => row.profile) as unknown as ProfileSummary[],
        total: count ?? 0,
      };
    },
  });
}

/** Everyone who's liked a post, newest first. */
export function useLikers(postId: string | undefined) {
  return useQuery({
    queryKey: ['likers', postId],
    enabled: !!postId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('likes')
        .select('created_at, profile:profiles!likes_user_id_fkey(id, username, display_name, avatar_path)')
        .eq('post_id', postId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map((row) => row.profile) as unknown as ProfileSummary[];
    },
  });
}

/**
 * Editing your own profile. Only the four columns the client is granted UPDATE
 * on are writable here -- the counters are the database's business (see
 * migration 0007).
 */
export interface ProfilePatch {
  username?: string;
  display_name?: string | null;
  bio?: string | null;
  avatar_path?: string | null;
  onboarded?: boolean;
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  const userId = useUserId();

  return useMutation({
    mutationFn: async (patch: ProfilePatch) => {
      const { data, error } = await supabase
        .from('profiles')
        .update(patch)
        .eq('id', userId!)
        .select()
        .single();
      if (error) throw error;
      return data as Profile;
    },
    onSuccess: () => {
      // The username is part of the profile route, and shows up in search
      // results and every comment row, so cast the net wide.
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['search'] });
      qc.invalidateQueries({ queryKey: ['comments'] });
    },
  });
}

export function useToggleFollow() {
  const qc = useQueryClient();
  const userId = useUserId();
  const { refreshProfile } = useAuth();

  return useMutation({
    mutationFn: async ({ profileId, following }: { profileId: string; following: boolean }) => {
      if (following) {
        const { error } = await supabase
          .from('follows')
          .delete()
          .eq('follower_id', userId!)
          .eq('followee_id', profileId);
        if (error) throw error;
      } else {
        // upsert, not insert: `follows` is keyed on (follower_id,
        // followee_id), so any path that fires a follow when one already
        // exists -- two fast taps, a cache that hasn't caught up -- used to
        // surface `duplicate key value violates unique constraint
        // "follows_pkey"` verbatim in an alert. Following someone you
        // already follow is a no-op, not an error, so say that in SQL.
        const { error } = await supabase
          .from('follows')
          .upsert(
            { follower_id: userId!, followee_id: profileId },
            { onConflict: 'follower_id,followee_id', ignoreDuplicates: true }
          );
        if (error) throw error;
      }
    },

    // Follow is the one social action with no visible latency budget: the
    // button is the feedback. Without this the label stayed on "Follow"
    // until the write AND a refetch of ['following'] both landed, which on
    // cellular is a second or more of a button that looks broken -- so
    // people tapped again. useToggleLike right above does the same thing
    // for hearts; this brings follow in line.
    onMutate: async ({ profileId, following }) => {
      const followingKey = ['following', userId, profileId];
      await qc.cancelQueries({ queryKey: followingKey });

      const previousFollowing = qc.getQueryData<boolean>(followingKey);
      qc.setQueryData(followingKey, !following);

      // The count next to the button lives on the cached profile row, which
      // is keyed by username rather than id -- so find it by scanning the
      // profile entries rather than guessing the key.
      const profileSnapshots = qc.getQueriesData<Profile>({ queryKey: ['profile'] });
      for (const [key, profile] of profileSnapshots) {
        if (profile?.id !== profileId) continue;
        qc.setQueryData<Profile>(key, {
          ...profile,
          follower_count: Math.max(0, profile.follower_count + (following ? -1 : 1)),
        });
      }

      return { followingKey, previousFollowing, profileSnapshots };
    },

    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      qc.setQueryData(ctx.followingKey, ctx.previousFollowing);
      for (const [key, profile] of ctx.profileSnapshots) {
        qc.setQueryData(key, profile);
      }
    },

    onSuccess: (_d, { profileId }) => {
      qc.invalidateQueries({ queryKey: ['following', userId, profileId] });
      qc.invalidateQueries({ queryKey: ['profile'] });
      // Following someone pulls their whole back catalogue into your feed, and
      // drops them out of explore. Both lists have to be rebuilt.
      qc.invalidateQueries({ queryKey: ['home_feed'] });
      qc.invalidateQueries({ queryKey: ['explore_feed'] });
      // The people behind the counts, and the two lists derived from the
      // graph. Without these the Follows screen's header said N+1 while its
      // rows (still within staleTime) showed N with you missing, "Followed
      // by …" lagged, and a just-followed account stayed under Suggested.
      qc.invalidateQueries({ queryKey: ['follow-list'] });
      qc.invalidateQueries({ queryKey: ['mutual-followers'] });
      qc.invalidateQueries({ queryKey: ['suggested-profiles'] });
      // The Profile tab renders AuthProvider's own copy of your row, not the
      // ['profile'] cache -- its "following" count only moved when something
      // else happened to refresh it.
      void refreshProfile();
    },
  });
}

/**
 * Deletes a post. RLS restricts the row delete to the post's own author, and
 * comments/likes cascade with it. The storage object is removed best-effort
 * afterward — the post is already gone from every list either way, so a
 * failed cleanup just leaves an orphaned file rather than blocking anything.
 */
export function useDeletePost() {
  const qc = useQueryClient();
  const { refreshProfile } = useAuth();
  return useMutation({
    mutationFn: async (post: Pick<FeedPost, 'id' | 'image_path' | 'thumb_path'>) => {
      const { error } = await supabase.from('posts').delete().eq('id', post.id);
      if (error) throw error;
      // Both objects: every post since 0022 uploads a grid thumbnail next to
      // the full image, and removing only the latter left one file per
      // deleted post in the bucket for good.
      await supabase.storage
        .from(PHOTOS_BUCKET)
        .remove([post.image_path, ...(post.thumb_path ? [post.thumb_path] : [])]);
    },
    onSuccess: (_d, post) => {
      qc.invalidateQueries({ queryKey: ['home_feed'] });
      qc.invalidateQueries({ queryKey: ['explore_feed'] });
      qc.invalidateQueries({ queryKey: ['profile-posts'] });
      // Tags cascade with the post; anyone tagged on it loses a "Photos of
      // you" cell.
      qc.invalidateQueries({ queryKey: ['tagged-posts'] });
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['post', post.id] });
      // Deleting today's only post re-locks Explore; and the Profile tab's
      // "posts" count lives on AuthProvider's row, same as in useToggleFollow.
      qc.invalidateQueries({ queryKey: ['posted-today'] });
      void refreshProfile();
    },
  });
}

/**
 * Editing your own post's caption. RLS (`posts_update_own`) and the column
 * grant (`update (caption, filter_name)` -- see 0004_rls.sql) already scope
 * this to the post's own author and this one column; nothing new needed on
 * the database side to support it.
 */
export function useUpdatePostCaption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ postId, caption }: { postId: string; caption: string | null }) => {
      const { error } = await supabase.from('posts').update({ caption }).eq('id', postId);
      if (error) throw error;
    },
    onSuccess: (_d, { postId }) => {
      qc.invalidateQueries({ queryKey: ['home_feed'] });
      qc.invalidateQueries({ queryKey: ['explore_feed'] });
      qc.invalidateQueries({ queryKey: ['profile-posts'] });
      qc.invalidateQueries({ queryKey: ['post', postId] });
    },
  });
}

export function useSearchProfiles(q: string) {
  return useQuery({
    queryKey: ['search', q],
    enabled: q.trim().length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('search_profiles', { q: q.trim(), lim: 20 });
      if (error) throw error;
      return (data ?? []) as Profile[];
    },
  });
}

/**
 * Search the music catalog.
 *
 * Shaped like useSearchProfiles above, with two differences forced by the
 * catalog being a rate-limited third party (lib/music.ts): callers must pass an
 * already-debounced query, and results are held far longer than the app's
 * 30-second default because a song's title and preview URL don't change. That
 * long staleTime is what makes backspacing through a query free instead of
 * spending another request per keystroke.
 */
export function useTrackSearch(q: string) {
  return useQuery({
    queryKey: ['track-search', q.trim()],
    enabled: q.trim().length > 0,
    // react-query aborts this signal when the query key changes, which cancels
    // the in-flight request for a search the user has already typed past.
    queryFn: ({ signal }) => searchTracks(q, signal),
    staleTime: 60 * 60 * 1000,
    retry: 0,
  });
}

/** Search the GIF catalog. Mirrors useTrackSearch exactly -- same reasoning
 *  (debounced by the caller, held long since results don't change, no retry
 *  storm on a failed third-party search). */
export function useGifSearch(q: string) {
  return useQuery({
    queryKey: ['gif-search', q.trim()],
    enabled: q.trim().length > 0,
    queryFn: ({ signal }) => searchGifs(q, signal),
    staleTime: 60 * 60 * 1000,
    retry: 0,
  });
}

/**
 * Five accounts one hop further into the viewer's graph -- people followed by
 * people they follow, minus anyone already followed and the viewer
 * themselves. Shown under the search bar before a query is typed. Same
 * no-backfill rule as Explore: a viewer who follows nobody gets an empty list.
 */
export function useSuggestedProfiles() {
  const userId = useUserId();
  return useQuery({
    queryKey: ['suggested-profiles', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('suggested_profiles', { lim: 5 });
      if (error) throw error;
      return (data ?? []) as Profile[];
    },
  });
}

// ---------------------------------------------------------------------------
// DMs — a thread's identity is the pair (thread_user_id, thread_with_id):
// which human, and which of the small set of accounts allowed to write into
// someone else's thread (ishaan, or a bot like Drake) it's with. A regular
// user can have more than one thread now (one per thread_with_id); ishaan's
// own inbox only ever manages the ones where thread_with_id = his own id.
// ---------------------------------------------------------------------------

/**
 * A thread's messages, kept live by a Realtime subscription -- without this,
 * a message sent from the other side never appears until you leave the
 * screen and come back (the typing indicator is a real Realtime broadcast
 * channel already; the messages themselves weren't). The subscription can
 * only filter on one column, so it's scoped to `thread_user_id` and the
 * handler double-checks `thread_with_id` client-side before invalidating --
 * cheap, since a filter that's slightly too broad just means the odd wasted
 * refetch of a query no screen currently cares about.
 */
export function useDMThread(threadUserId: string | undefined, threadWithId: string | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!threadUserId || !threadWithId) return;
    const channel = supabase
      .channel(`dm-thread:${threadUserId}:${threadWithId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'dm_messages', filter: `thread_user_id=eq.${threadUserId}` },
        (payload) => {
          if ((payload.new as { thread_with_id?: string }).thread_with_id === threadWithId) {
            qc.invalidateQueries({ queryKey: ['dm-thread', threadUserId, threadWithId] });
          }
        },
      )
      // UPDATE too, not just INSERT -- a like from the other participant
      // (or read_at flipping) needs to show up live, the same as a new
      // message does, not just next time this screen happens to refetch.
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'dm_messages', filter: `thread_user_id=eq.${threadUserId}` },
        (payload) => {
          if ((payload.new as { thread_with_id?: string }).thread_with_id === threadWithId) {
            qc.invalidateQueries({ queryKey: ['dm-thread', threadUserId, threadWithId] });
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [threadUserId, threadWithId, qc]);

  return useQuery({
    queryKey: ['dm-thread', threadUserId, threadWithId],
    enabled: !!threadUserId && !!threadWithId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('dm_messages')
        // dm_messages has two FKs into profiles (sender_id, thread_user_id) --
        // the explicit constraint name is required to disambiguate which one
        // this embed follows.
        .select('*, sender:profiles!dm_messages_sender_id_fkey(username, avatar_path)')
        .eq('thread_user_id', threadUserId!)
        .eq('thread_with_id', threadWithId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data as unknown as DMMessage[];
    },
  });
}

export function useSendDM(threadUserId: string | undefined, threadWithId: string | undefined) {
  const qc = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: async (body: string) => {
      const { error } = await supabase
        .from('dm_messages')
        .insert({ thread_user_id: threadUserId!, thread_with_id: threadWithId!, sender_id: userId!, body });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dm-thread', threadUserId, threadWithId] });
      qc.invalidateQueries({ queryKey: ['dm-inbox'] });
      qc.invalidateQueries({ queryKey: ['dm-my-threads'] });
    },
  });
}

/** ishaan's inbox: one row per thread, most recently active first. Empty for
 *  anyone else — enforced independently by the dm_inbox() function itself. */
export function useDMInbox() {
  const userId = useUserId();
  return useQuery({
    // Keyed by user like every other per-account query, so one account's
    // inbox can never be served to the next one signed in on the device.
    queryKey: ['dm-inbox', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('dm_inbox', { lim: 50 });
      if (error) throw error;
      return (data ?? []) as DMThreadSummary[];
    },
  });
}

/**
 * Sandboxed peer-to-peer DM partners for the current user (0027) -- accounts
 * outside the ishaan/Drake hub this user is explicitly allowlisted to DM
 * directly. Empty for almost everyone; MyThreads renders one row per profile
 * this returns, the same way it already does for ishaan and the bot.
 */
export function useDMPeers() {
  const userId = useUserId();
  return useQuery({
    queryKey: ['dm-peers', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_dm_peers');
      if (error) throw error;
      return (data ?? []) as ProfileSummary[];
    },
  });
}

/**
 * A regular user's own threads (ishaan, the Drake bot, and any sandboxed
 * peers), keyed by the other participant's id, with a preview of the latest
 * message in each if any. Goes through `my_dm_thread_previews()` (0018,
 * broadened by 0027 to also cover peer threads) rather than fetching a
 * user's entire message history and reducing it client-side -- that used to
 * pull every row in both threads just to keep two preview lines.
 */
export function useMyDMThreads() {
  const userId = useUserId();
  return useQuery({
    queryKey: ['dm-my-threads', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_dm_thread_previews');
      if (error) throw error;
      const latest = new Map<string, { sender_id: string; body: string; created_at: string }>();
      for (const row of (data ?? []) as {
        thread_with_id: string;
        last_sender_id: string;
        last_body: string;
        last_created_at: string;
      }[]) {
        latest.set(row.thread_with_id, {
          sender_id: row.last_sender_id,
          body: row.last_body,
          created_at: row.last_created_at,
        });
      }
      return latest;
    },
  });
}

/**
 * Red-dot state for the DM icon. RLS lets ishaan SELECT every row in the
 * table (see 0008_dm.sql), including threads he's not actually a party to
 * (e.g. a Drake DM to a regular user) -- an unscoped unread count would pick
 * those up too, and since ishaan has no screen that can ever open or mark
 * read a thread he's not in, the badge would stay lit forever after the
 * first one. Scoped explicitly instead of trusting RLS to do it, by matching
 * either id column: for a regular user `thread_with_id.eq` only ever matches
 * a sandboxed peer thread where they hold the larger id (0027) -- RLS itself
 * still gates which rows actually come back, so this is a no-op for anyone
 * without a peer thread, same as it always was.
 */
export function useHasUnreadDMs() {
  const userId = useUserId();
  return useQuery({
    queryKey: ['dm-unread', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('dm_messages')
        .select('*', { count: 'exact', head: true })
        .is('read_at', null)
        .neq('sender_id', userId!)
        .or(`thread_with_id.eq.${userId},thread_user_id.eq.${userId}`);
      if (error) throw error;
      return (count ?? 0) > 0;
    },
    // The app-wide default disables this, but the badge needs to catch
    // "someone messaged me while I was on another app" the moment you come
    // back, not on some arbitrary staleTime window.
    refetchOnWindowFocus: true,
  });
}

/** Marks every unread incoming message in a thread as read. */
export function useMarkDMRead(threadUserId: string | undefined, threadWithId: string | undefined) {
  const qc = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: async () => {
      if (!threadUserId || !threadWithId) return;
      const { error } = await supabase
        .from('dm_messages')
        .update({ read_at: new Date().toISOString() })
        .eq('thread_user_id', threadUserId)
        .eq('thread_with_id', threadWithId)
        .neq('sender_id', userId!)
        .is('read_at', null);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dm-unread'] });
      qc.invalidateQueries({ queryKey: ['dm-thread', threadUserId, threadWithId] });
      qc.invalidateQueries({ queryKey: ['dm-inbox'] });
      qc.invalidateQueries({ queryKey: ['dm-my-threads'] });
    },
  });
}

/**
 * Hearting a message -- either thread member can like any message,
 * including their own (unlike read_at, which only the recipient may set;
 * see 0023_dm_message_likes.sql for why that needed a trigger, not just a
 * row policy). Tapping a message you've already liked un-likes it.
 */
export function useToggleMessageLike(
  threadUserId: string | undefined,
  threadWithId: string | undefined
) {
  const qc = useQueryClient();
  const userId = useUserId();
  const queryKey = ['dm-thread', threadUserId, threadWithId];

  return useMutation({
    mutationFn: async ({ messageId, likedByMe }: { messageId: string; likedByMe: boolean }) => {
      const { error } = await supabase
        .from('dm_messages')
        .update({ liked_by: likedByMe ? null : userId! })
        .eq('id', messageId);
      if (error) throw error;
    },
    // Optimistic -- a double-tap should feel instant, not wait on a round
    // trip. The Realtime UPDATE subscription (useDMThread) will also
    // invalidate this same query once the other side's client sees it,
    // which is fine: it just re-confirms what's already on screen.
    onMutate: async ({ messageId, likedByMe }) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<DMMessage[]>(queryKey);
      qc.setQueryData<DMMessage[]>(queryKey, (old) =>
        old?.map((m) => (m.id === messageId ? { ...m, liked_by: likedByMe ? null : userId! } : m))
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(queryKey, context.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey });
    },
  });
}

/**
 * Ephemeral "is typing" state over a Supabase Realtime broadcast channel --
 * nothing here touches the database, it only exists for as long as both
 * people happen to be in the thread at the same time. Scoped to the same
 * (threadUserId, threadWithId) pair that identifies a DM thread, so both
 * participants land on the same channel regardless of which side of it
 * they're on.
 */
export function useTypingIndicator(
  threadUserId: string | undefined,
  threadWithId: string | undefined,
  meId: string | null
) {
  const [otherTyping, setOtherTyping] = useState(false);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentRef = useRef(0);
  // The channel object exists synchronously once `.channel()` returns, but
  // the Realtime join it kicks off is async -- sending a broadcast before
  // that join completes is silently dropped, which meant typing fast enough
  // right after opening a thread never notified the other side at all.
  const joinedRef = useRef(false);

  useEffect(() => {
    setOtherTyping(false);
    joinedRef.current = false;
    if (!threadUserId || !threadWithId) return;

    const channel = supabase
      .channel(`dm-typing:${threadUserId}:${threadWithId}`, {
        config: { broadcast: { self: false } },
      })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (payload?.userId === meId) return;
        setOtherTyping(true);
        // No explicit "stopped typing" event -- this just expires on its
        // own, same as iMessage/WhatsApp, so a dropped connection or a
        // closed app can't leave the bubble stuck on forever.
        if (clearTimer.current) clearTimeout(clearTimer.current);
        clearTimer.current = setTimeout(() => setOtherTyping(false), 3000);
      })
      .subscribe((status) => {
        joinedRef.current = status === 'SUBSCRIBED';
      });
    channelRef.current = channel;

    return () => {
      joinedRef.current = false;
      if (clearTimer.current) clearTimeout(clearTimer.current);
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [threadUserId, threadWithId, meId]);

  const notifyTyping = useCallback(() => {
    if (!joinedRef.current) return;
    // Throttled -- one broadcast per burst of typing is plenty, no need to
    // send on every keystroke.
    const now = Date.now();
    if (now - lastSentRef.current < 2000) return;
    lastSentRef.current = now;
    channelRef.current?.send({ type: 'broadcast', event: 'typing', payload: { userId: meId } });
  }, [meId]);

  return { otherTyping, notifyTyping };
}

/** Red-dot state for the Activity tab: anything newer than the last visit? */
export function useHasUnreadActivity() {
  const { profile } = useAuth();
  const { data: events } = useActivity();
  const newest = events?.[0]?.created_at;
  if (!newest) return false;
  if (!profile?.activity_read_at) return true;
  return new Date(newest).getTime() > new Date(profile.activity_read_at).getTime();
}

/** Call when the Activity tab is opened, to clear its red dot. */
export function useMarkActivityRead() {
  const qc = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('profiles')
        .update({ activity_read_at: new Date().toISOString() })
        .eq('id', userId!);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

/**
 * Whether the viewer has posted since local midnight -- one half of
 * Explore's unlock condition (see useExploreLockState). "Today" is the
 * device's own local calendar day, not UTC, so it matches what the person
 * actually experiences as "today."
 */
export function useHasPostedToday() {
  const userId = useUserId();
  // Part of the key, not just the queryFn: "today" used to be computed
  // inside the fetch and the query was kept permanently subscribed by the
  // Explore tab icon, so it only ever re-ran on cold start, reconnect, or
  // a post. Someone who posted yesterday and just reopened the app kept
  // Explore unlocked indefinitely. Keying by the local calendar day means
  // the first render after midnight is a different query, and
  // refetchOnWindowFocus catches the common "reopen the app next morning"
  // path the same way the activity and DM badges already do.
  const today = localDayKey();
  return useQuery({
    queryKey: ['posted-today', userId, today],
    enabled: !!userId,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const { count, error } = await supabase
        .from('posts')
        .select('*', { count: 'exact', head: true })
        .eq('author_id', userId!)
        .gte('created_at', startOfToday.toISOString());
      if (error) throw error;
      return (count ?? 0) > 0;
    },
  });
}

/** The device's local calendar day, e.g. "2026-09-14". */
function localDayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Posts of your own required before Explore's daily gate even applies. */
export const EXPLORE_POST_THRESHOLD = 5;

export interface ExploreLockState {
  /** True while either sub-check hasn't resolved yet. */
  isLoading: boolean;
  locked: boolean;
  /** Haven't reached the one-time 5-post threshold yet -- this gate is
   * checked first, and doesn't care what day it is. */
  needsMorePosts: boolean;
  /** Past the 5-post threshold, but haven't posted today specifically. */
  needsPostToday: boolean;
  postCount: number;
}

/**
 * Explore unlocks on two combined conditions, not one: post 5 photos total
 * (a one-time threshold, checked regardless of today's activity), and THEN
 * it becomes a daily gate on top of that -- post today or it's locked again,
 * re-evaluated every day. Centralized here so the Explore screen and the
 * tab-bar badge can't disagree about whether it's actually locked.
 */
export function useExploreLockState(): ExploreLockState {
  const { profile } = useAuth();
  const { data: postedToday, isLoading: postedTodayLoading } = useHasPostedToday();
  const postCount = profile?.post_count ?? 0;
  const needsMorePosts = postCount < EXPLORE_POST_THRESHOLD;
  const needsPostToday = !needsMorePosts && postedToday === false;
  return {
    isLoading: !profile || postedTodayLoading,
    locked: needsMorePosts || needsPostToday,
    needsMorePosts,
    needsPostToday,
    postCount,
  };
}
