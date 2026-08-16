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
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useExploreFeed();

  const posts = useMemo(() => data?.pages.flat() ?? [], [data]);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.center} edges={['top']}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  if (isError) {
    return (
      <SafeAreaView style={styles.center} edges={['top']}>
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
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Explore</Text>
        <Pressable onPress={() => router.push('/search')} hitSlop={12}>
          <Feather name="search" size={20} color="#262626" />
        </Pressable>
      </View>

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
  root: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  header: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#dbdbdb',
  },
  title: { fontSize: 17, fontWeight: '600', color: '#262626' },
  footerSpinner: { marginVertical: 24 },
  // Why this photo reached you — the thing that made 2015 Explore feel like a
  // place your friends had been, rather than a feed of strangers.
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
