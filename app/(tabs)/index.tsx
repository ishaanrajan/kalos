import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter, useScrollToTop } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { PostCard } from '../../components/PostCard';
import { EndOfFeed } from '../../components/EndOfFeed';
import { EmptyState } from '../../components/EmptyState';
import { useDeletePost, useHasUnreadDMs, useHomeFeed, useToggleLike } from '../../lib/queries';
import { photoUrl, avatarUrl } from '../../lib/supabase';
import { useUserId } from '../../lib/auth';
import { confirmDestructive, showActionSheet } from '../../lib/actionSheet';
import { useTheme } from '../../lib/theme';
import type { FeedPost } from '../../lib/types';

export default function Feed() {
  const router = useRouter();
  const userId = useUserId();
  const { colors, wordmarkFontFamily } = useTheme();
  const { data: hasUnreadDMs } = useHasUnreadDMs();
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useHomeFeed();
  const toggleLike = useToggleLike();
  const deletePost = useDeletePost();
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<FlatList<FeedPost>>(null);
  // Tapping the Home tab while already on it should jump the feed to the
  // top, matching standard tab-bar behavior -- this hook listens for that
  // "already focused" tab press itself, no manual wiring in _layout.tsx.
  useScrollToTop(listRef);

  const posts = useMemo(() => data?.pages.flat() ?? [], [data]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  // Every callback below depends on `.mutate` rather than on the mutation
  // object, because useMutation() returns `{ ...result, mutate, mutateAsync }`
  // -- a brand-new object on every render, including the two render passes a
  // single like triggers. Depending on the object made `renderItem` change
  // identity on every render, which re-rendered every mounted card (see the
  // React.memo note in components/PostCard.tsx). `mutate` itself is a
  // useCallback keyed on the observer, so it is stable for the screen's life.
  const deleteOwnPost = useCallback(
    (post: FeedPost) => {
      confirmDestructive('Delete post?', 'Delete Post', () => {
        deletePost.mutate(post, {
          onError: (e) => Alert.alert('Could not delete post', e instanceof Error ? e.message : undefined),
        });
      });
    },
    [deletePost.mutate]
  );

  const showPostOptions = useCallback(
    (post: FeedPost) => {
      showActionSheet('Post options', [
        { label: 'Edit Caption', onPress: () => router.push(`/edit-caption/${post.id}`) },
        { label: 'Delete Post', destructive: true, onPress: () => deleteOwnPost(post) },
      ]);
    },
    [router, deleteOwnPost]
  );

  // One identity per handler for the whole list, not one per card per render:
  // PostCard's handlers take the post they fired on precisely so these can be
  // hoisted out of renderItem, which is what lets its React.memo skip the
  // cards a like didn't touch.
  const likePost = useCallback(
    (post: FeedPost) => toggleLike.mutate({ postId: post.id, liked: post.viewer_has_liked }),
    [toggleLike.mutate]
  );
  const openAuthor = useCallback(
    (post: FeedPost) => router.push(`/profile/${post.author_username}`),
    [router]
  );
  const openComments = useCallback((post: FeedPost) => router.push(`/post/${post.id}`), [router]);
  const openLikes = useCallback((post: FeedPost) => router.push(`/likes/${post.id}`), [router]);
  const openMention = useCallback(
    (username: string) => router.push(`/profile/${username}`),
    [router]
  );

  const renderItem = useCallback(
    ({ item }: { item: FeedPost }) => (
      <PostCard
        post={item}
        imageUrl={photoUrl(item.image_path)}
        avatarUrl={avatarUrl(item.author_avatar_path)}
        onLike={likePost}
        onPressAuthor={openAuthor}
        onPressComments={openComments}
        onPressLikes={openLikes}
        onPressOptions={item.author_id === userId ? showPostOptions : undefined}
        onPressMention={openMention}
        previewComments={item.preview_comments}
      />
    ),
    [likePost, openAuthor, openComments, openLikes, openMention, userId, showPostOptions]
  );

  if (isLoading) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: colors.surface }]} edges={['top']}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  // Only when there is nothing to show. React Query's "error" reducer sets
  // status: 'error' unconditionally and *keeps* state.data, so isError is
  // true even for a feed that is fully loaded and six pages deep -- and with
  // `retry: 1` in app/_layout.tsx, two failed requests in a tunnel is all it
  // takes. Gating the full-screen state on isError alone meant a pull to
  // refresh could throw away every loaded post and the scroll position with
  // them, and "Try again" then refetched from page 1. When we already have
  // posts the failure is reported in the banner below instead.
  if (isError && !data) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: colors.surface }]} edges={['top']}>
        <EmptyState
          icon="alert-circle"
          title="Couldn't load your feed"
          body={error instanceof Error ? error.message : 'Something went wrong.'}
          actionLabel="Try again"
          onAction={() => refetch()}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.headerSpacer}>
          <Pressable
            onPress={() => router.push('/(tabs)/new')}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="New post"
          >
            <Feather name="camera" size={22} color={colors.text} />
          </Pressable>
        </View>
        <Text style={[styles.wordmark, { color: colors.text, fontFamily: wordmarkFontFamily }]}>
          Kalos
        </Text>
        <View style={styles.headerSpacer}>
          <Pressable
            onPress={() => router.push('/dm')}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={hasUnreadDMs ? 'Messages, unread' : 'Messages'}
          >
            <Feather name="send" size={22} color={colors.text} />
            {hasUnreadDMs ? <View style={[styles.dot, { backgroundColor: colors.heart, borderColor: colors.surface }]} /> : null}
          </Pressable>
        </View>
      </View>

      {/* The non-destructive half of the fix above: a refresh that failed
          against an already-loaded feed says so in one line and offers the
          retry, leaving the list -- and the reader's place in it -- alone. */}
      {isError ? (
        <Pressable
          onPress={() => refetch()}
          style={[styles.errorBanner, { backgroundColor: colors.surfaceAlt, borderBottomColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel="Couldn't refresh your feed. Tap to try again."
        >
          <Feather name="alert-circle" size={14} color={colors.textSecondary} />
          <Text style={[styles.errorBannerText, { color: colors.textSecondary }]} numberOfLines={1}>
            Couldn't refresh — showing what's already loaded.
          </Text>
          <Text style={[styles.errorBannerAction, { color: colors.accent }]}>Retry</Text>
        </Pressable>
      ) : null}

      <FlatList
        ref={listRef}
        data={posts}
        keyExtractor={(p) => p.id}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        onEndReached={() => hasNextPage && !isFetchingNextPage && fetchNextPage()}
        onEndReachedThreshold={0.6}
        ListEmptyComponent={
          <EmptyState
            icon="camera"
            title="Your feed is quiet"
            body="Follow a few people, or post the first photo yourself."
            actionLabel="Find people to follow"
            onAction={() => router.push('/search')}
          />
        }
        // The feed ends. When there is no next page we say so, rather than
        // backfilling with posts from strangers to keep you scrolling.
        ListFooterComponent={
          isFetchingNextPage ? (
            <ActivityIndicator style={styles.footerSpinner} />
          ) : !hasNextPage && posts.length > 0 ? (
            <EndOfFeed />
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerSpacer: { width: 24, alignItems: 'flex-end' },
  wordmark: { fontSize: 24, fontWeight: '300', letterSpacing: 0.5 },
  dot: {
    position: 'absolute',
    top: -1,
    right: -1,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1.5,
  },
  footerSpinner: { marginVertical: 24 },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  errorBannerText: { flex: 1, fontSize: 13 },
  errorBannerAction: { fontSize: 13, fontWeight: '600' },
});
