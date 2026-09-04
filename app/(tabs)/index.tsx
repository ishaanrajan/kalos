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
import { useAuth, useUserId } from '../../lib/auth';
import { confirmDestructive } from '../../lib/actionSheet';
import { useTheme } from '../../lib/theme';
import type { FeedPost } from '../../lib/types';

export default function Feed() {
  const router = useRouter();
  const userId = useUserId();
  const { profile } = useAuth();
  const { colors } = useTheme();
  // Everyone's one DM thread is with "ishaan" specifically; ishaan gets the
  // inbox listing every thread instead of a single one.
  const dmHref = profile?.username === 'ishaan' ? '/dm' : '/dm/ishaan';
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

  const deleteOwnPost = useCallback(
    (post: FeedPost) => {
      confirmDestructive('Delete post?', 'Delete Post', () => {
        deletePost.mutate(post, {
          onError: (e) => Alert.alert('Could not delete post', e instanceof Error ? e.message : undefined),
        });
      });
    },
    [deletePost]
  );

  const renderItem = useCallback(
    ({ item }: { item: FeedPost }) => (
      <PostCard
        post={item}
        imageUrl={photoUrl(item.image_path)}
        avatarUrl={avatarUrl(item.author_avatar_path)}
        onLike={() => toggleLike.mutate({ postId: item.id, liked: item.viewer_has_liked })}
        onPressAuthor={() => router.push(`/profile/${item.author_username}`)}
        onPressComments={() => router.push(`/post/${item.id}`)}
        onPressLikes={() => router.push(`/likes/${item.id}`)}
        onPressOptions={item.author_id === userId ? () => deleteOwnPost(item) : undefined}
        previewComments={item.preview_comments}
      />
    ),
    [router, toggleLike, userId, deleteOwnPost]
  );

  if (isLoading) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: colors.surface }]} edges={['top']}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  if (isError) {
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
        <View style={styles.headerSpacer} />
        <Text style={[styles.wordmark, { color: colors.text }]}>Kalos</Text>
        <View style={styles.headerSpacer}>
          <Pressable
            onPress={() => router.push(dmHref)}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={hasUnreadDMs ? 'Messages, unread' : 'Messages'}
          >
            <Feather name="send" size={22} color={colors.text} />
            {hasUnreadDMs ? <View style={[styles.dot, { backgroundColor: colors.heart, borderColor: colors.surface }]} /> : null}
          </Pressable>
        </View>
      </View>

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
});
