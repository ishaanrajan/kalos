import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { PHOTOS_BUCKET, supabase } from './supabase';
import { useAuth, useUserId } from './auth';
import {
  PAGE_SIZE,
  type ActivityEvent,
  type Comment,
  type DMMessage,
  type DMThreadSummary,
  type FeedPost,
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

export function usePost(postId: string | undefined) {
  return useQuery({
    queryKey: ['post', postId],
    enabled: !!postId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('posts')
        .select('*, author:profiles!posts_author_id_fkey(id, username, display_name, avatar_path)')
        .eq('id', postId!)
        .single();
      if (error) throw error;
      return data as FeedPost & { author: Pick<Profile, 'id' | 'username' | 'display_name' | 'avatar_path'> };
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

export function useAddComment(postId: string) {
  const qc = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: async (body: string) => {
      const { error } = await supabase
        .from('comments')
        .insert({ post_id: postId, author_id: userId!, body });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['comments', postId] });
      qc.invalidateQueries({ queryKey: ['post', postId] });
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
      await qc.cancelQueries();
      const patch = (p: FeedPost): FeedPost =>
        p.id === postId
          ? { ...p, viewer_has_liked: !liked, like_count: p.like_count + (liked ? -1 : 1) }
          : p;

      const snapshots = qc.getQueriesData<InfiniteData<FeedPost[]>>({ queryKey: ['home_feed'] })
        .concat(qc.getQueriesData<InfiniteData<FeedPost[]>>({ queryKey: ['explore_feed'] }));

      for (const [key, value] of snapshots) {
        if (!value) continue;
        qc.setQueryData<InfiniteData<FeedPost[]>>(key, {
          ...value,
          pages: value.pages.map((page) => page.map(patch)),
        });
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      for (const [key, value] of ctx?.snapshots ?? []) qc.setQueryData(key, value);
    },
    onSettled: (_d, _e, { postId }) => {
      qc.invalidateQueries({ queryKey: ['post', postId] });
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
        const { error } = await supabase
          .from('follows')
          .insert({ follower_id: userId!, followee_id: profileId });
        if (error) throw error;
      }
    },
    onSuccess: (_d, { profileId }) => {
      qc.invalidateQueries({ queryKey: ['following', userId, profileId] });
      qc.invalidateQueries({ queryKey: ['profile'] });
      // Following someone pulls their whole back catalogue into your feed, and
      // drops them out of explore. Both lists have to be rebuilt.
      qc.invalidateQueries({ queryKey: ['home_feed'] });
      qc.invalidateQueries({ queryKey: ['explore_feed'] });
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
  return useMutation({
    mutationFn: async (post: Pick<FeedPost, 'id' | 'image_path'>) => {
      const { error } = await supabase.from('posts').delete().eq('id', post.id);
      if (error) throw error;
      await supabase.storage.from(PHOTOS_BUCKET).remove([post.image_path]);
    },
    onSuccess: (_d, post) => {
      qc.invalidateQueries({ queryKey: ['home_feed'] });
      qc.invalidateQueries({ queryKey: ['explore_feed'] });
      qc.invalidateQueries({ queryKey: ['profile-posts'] });
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['post', post.id] });
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

// ---------------------------------------------------------------------------
// DMs — a thread's identity is the pair (thread_user_id, thread_with_id):
// which human, and which of the small set of accounts allowed to write into
// someone else's thread (ishaan, or a bot like Drake) it's with. A regular
// user can have more than one thread now (one per thread_with_id); ishaan's
// own inbox only ever manages the ones where thread_with_id = his own id.
// ---------------------------------------------------------------------------

export function useDMThread(threadUserId: string | undefined, threadWithId: string | undefined) {
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
    },
  });
}

/** ishaan's inbox: one row per thread, most recently active first. Empty for
 *  anyone else — enforced independently by the dm_inbox() function itself. */
export function useDMInbox() {
  return useQuery({
    queryKey: ['dm-inbox'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('dm_inbox', { lim: 50 });
      if (error) throw error;
      return (data ?? []) as DMThreadSummary[];
    },
  });
}

/**
 * Red-dot state for the DM icon. RLS already scopes visible rows to "my
 * thread" for a regular user or "every thread" for ishaan, so a plain
 * unread-and-not-from-me count is correct for both without branching here.
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
        .neq('sender_id', userId!);
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

  useEffect(() => {
    setOtherTyping(false);
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
      .subscribe();
    channelRef.current = channel;

    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [threadUserId, threadWithId, meId]);

  const notifyTyping = useCallback(() => {
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
