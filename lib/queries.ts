import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { PHOTOS_BUCKET, supabase } from './supabase';
import { useUserId } from './auth';
import { PAGE_SIZE, type ActivityEvent, type Comment, type FeedPost, type Profile } from './types';

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
