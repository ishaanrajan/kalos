import { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { PhotoGrid } from '../../components/PhotoGrid';
import { EmptyState } from '../../components/EmptyState';
import { EndOfFeed } from '../../components/EndOfFeed';
import { useExploreFeed } from '../../lib/queries';
import { photoUrl } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';

/** Posts of your own required before Explore unlocks. */
const POSTS_TO_UNLOCK = 5;

/**
 * Explore, the way it used to work.
 *
 * Everything here arrived through the social graph: a post someone you follow
 * liked, or a post by someone they follow. Nothing is here because it is
 * "performing well" — there is no ranking signal in the query at all, and the
 * order is plain reverse-chronological.
 */
export default function Explore() {
  const router = useRouter();
  const { profile } = useAuth();
  const { colors } = useTheme();
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useExploreFeed();

  const posts = useMemo(() => data?.pages.flat() ?? [], [data]);

  if (profile && profile.post_count < POSTS_TO_UNLOCK) {
    const remaining = POSTS_TO_UNLOCK - profile.post_count;
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>Explore</Text>
        </View>
        <EmptyState
          icon="lock"
          title="Explore is locked"
          body={`Share ${remaining} more photo${remaining === 1 ? '' : 's'} to unlock it — you've posted ${profile.post_count} of ${POSTS_TO_UNLOCK}.`}
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

      <Pressable
        style={[styles.searchBar, { backgroundColor: colors.surfaceAlt }]}
        onPress={() => router.push('/search')}
        accessibilityRole="search"
        accessibilityLabel="Search accounts"
      >
        <Feather name="search" size={17} color={colors.textSecondary} />
        <Text style={[styles.searchPlaceholder, { color: colors.textSecondary }]}>Search accounts</Text>
      </Pressable>

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
    right: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 3,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  reasonText: { flex: 1, color: '#fff', fontSize: 9, fontWeight: '600' },
});
