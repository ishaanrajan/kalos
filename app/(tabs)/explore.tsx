import { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { PhotoGrid } from '../../components/PhotoGrid';
import { EmptyState } from '../../components/EmptyState';
import { EndOfFeed } from '../../components/EndOfFeed';
import { EXPLORE_POST_THRESHOLD, useExploreFeed, useExploreLockState } from '../../lib/queries';
import { photoThumbUrl } from '../../lib/supabase';
import { useTheme } from '../../lib/theme';

/**
 * Explore, the way it used to work.
 *
 * Everything here arrived through the social graph: a post someone you follow
 * liked, or a post by someone they follow. Nothing is here because it is
 * "performing well" — there is no ranking signal in the query at all, and the
 * order is plain reverse-chronological.
 *
 * Unlocking it is two combined conditions, checked in order: post 5 photos
 * total (a one-time threshold), and only once that's cleared does it become
 * a daily gate on top -- post today or it's locked again. See
 * useExploreLockState() for the combined logic.
 */
export default function Explore() {
  const router = useRouter();
  const { colors } = useTheme();
  const { locked, needsMorePosts, postCount, isLoading: lockLoading } = useExploreLockState();
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useExploreFeed();

  const posts = useMemo(() => data?.pages.flat() ?? [], [data]);

  // The search bar is the only way into /search that isn't the DM compose
  // button -- it stays reachable even while the photo grid itself is locked,
  // so a locked-out day doesn't cut someone off from the rest of the app.
  const searchBar = (
    <Pressable
      style={[styles.searchBar, { backgroundColor: colors.surfaceAlt }]}
      onPress={() => router.push('/search')}
      accessibilityRole="search"
      accessibilityLabel="Search accounts"
    >
      <Feather name="search" size={17} color={colors.textSecondary} />
      <Text style={[styles.searchPlaceholder, { color: colors.textSecondary }]}>Search accounts</Text>
    </Pressable>
  );

  if (lockLoading) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: colors.surface }]} edges={['top']}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  if (locked) {
    const remaining = EXPLORE_POST_THRESHOLD - postCount;
    const body = needsMorePosts
      ? `Share ${remaining} more photo${remaining === 1 ? '' : 's'} to unlock it — you've posted ${postCount} of ${EXPLORE_POST_THRESHOLD}.`
      : 'Post a photo today to unlock it.';
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>Explore</Text>
        </View>
        {searchBar}
        <EmptyState
          icon="lock"
          title="Explore is locked"
          body={body}
          actionLabel="New post"
          onAction={() => router.push('/(tabs)/new')}
        />
      </SafeAreaView>
    );
  }

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
          title="Couldn't load Explore"
          body="Something went wrong reaching the server."
          actionLabel="Try again"
          onAction={() => refetch()}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Explore</Text>
      </View>

      {searchBar}

      <PhotoGrid
        posts={posts}
        imageUrlFor={photoThumbUrl}
        onPressPost={(p) => router.push(`/post/${p.id}`)}
        onEndReached={() => hasNextPage && !isFetchingNextPage && fetchNextPage()}
        ListEmptyComponent={
          <EmptyState icon="compass" title="Nothing to explore yet" />
        }
        ListFooterComponent={
          isFetchingNextPage ? (
            <ActivityIndicator style={styles.footerSpinner} />
          ) : !hasNextPage && posts.length > 0 ? (
            <EndOfFeed title="That's everything" body="" />
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
    paddingHorizontal: 16,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
  },
  searchPlaceholder: { fontSize: 15 },
  title: { fontSize: 17, fontWeight: '600' },
  footerSpinner: { marginVertical: 24 },
});
