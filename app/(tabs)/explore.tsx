import { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { PhotoGrid } from '../../components/PhotoGrid';
import { EmptyState } from '../../components/EmptyState';
import { EndOfFeed } from '../../components/EndOfFeed';
import { useExploreFeed, useHasPostedToday } from '../../lib/queries';
import { photoUrl } from '../../lib/supabase';
import { useTheme } from '../../lib/theme';

/**
 * Explore, the way it used to work.
 *
 * Everything here arrived through the social graph: a post someone you follow
 * liked, or a post by someone they follow. Nothing is here because it is
 * "performing well" — there is no ranking signal in the query at all, and the
 * order is plain reverse-chronological.
 *
 * Unlocking it is a daily gate, not a one-time milestone: post today and
 * it's open for today; skip a day and it locks again until you post. See
 * useHasPostedToday() for what "today" means (the device's own local day).
 */
export default function Explore() {
  const router = useRouter();
  const { colors } = useTheme();
  const { data: postedToday, isLoading: postedTodayLoading } = useHasPostedToday();
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useExploreFeed();

  const posts = useMemo(() => data?.pages.flat() ?? [], [data]);
  const locked = postedToday === false;

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

  if (postedTodayLoading) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: colors.surface }]} edges={['top']}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  if (locked) {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>Explore</Text>
        </View>
        {searchBar}
        <EmptyState
          icon="lock"
          title="Explore is locked"
          body="Post a photo today to unlock it. Miss a day and it locks again -- that's the deal."
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
        imageUrlFor={(p) => photoUrl(p.image_path)}
        onPressPost={(p) => router.push(`/post/${p.id}`)}
        renderOverlay={(p) =>
          p.reason_username ? (
            <View style={styles.reason}>
              <Feather
                name={p.reason === 'liked_by' ? 'heart' : 'user-plus'}
                size={9}
                color="#fff"
              />
              <Text style={styles.reasonText} numberOfLines={1}>
                {p.reason_username}
              </Text>
            </View>
          ) : null
        }
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
  // Why this photo reached you — the thing that made 2015 Explore feel like a
  // place your friends had been, rather than a feed of strangers. Always a
  // dark scrim with white text/icon: it sits on top of an arbitrary photo,
  // not the app's own chrome, so it doesn't follow the theme.
  reason: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    maxWidth: '85%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    // Pill-shaped, matching the app's own overlay-badge radius token rather
    // than dipping below its type floor with a squared-off corner.
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  reasonText: { flexShrink: 1, color: '#fff', fontSize: 10, fontWeight: '600' },
});
