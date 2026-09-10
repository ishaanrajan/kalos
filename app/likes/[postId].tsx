import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { EmptyState } from '../../components/EmptyState';
import { UserRow } from '../../components/UserRow';
import { useLikers } from '../../lib/queries';
import { useTheme } from '../../lib/theme';

/** Who liked a post — the people behind the like count. */
export default function Likes() {
  const router = useRouter();
  const { postId } = useLocalSearchParams<{ postId: string }>();
  const { data: people, isLoading, isError, error, refetch } = useLikers(postId);
  const { colors } = useTheme();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  return (
    <View style={[styles.root, { backgroundColor: colors.surface }]}>
      <Stack.Screen options={{ title: 'Likes' }} />

      {isLoading ? (
        <View style={[styles.center, { backgroundColor: colors.surface }]}>
          <ActivityIndicator />
        </View>
      ) : isError ? (
        // The list has no way to distinguish "nobody liked this" from "the
        // query failed" -- both hand it an empty array -- so a dropped
        // connection used to state, confidently and wrongly, that a post
        // with a visible like count had no likes.
        <View style={[styles.center, { backgroundColor: colors.surface }]}>
          <EmptyState
            icon="alert-circle"
            title="Couldn't load likes"
            body={error instanceof Error ? error.message : 'Something went wrong.'}
            actionLabel="Try again"
            onAction={() => refetch()}
          />
        </View>
      ) : (
        <FlatList
          data={people ?? []}
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => (
            <UserRow profile={item} onPress={() => router.push(`/profile/${item.username}`)} />
          )}
          contentContainerStyle={styles.list}
          // Likes keep arriving after this screen opens, and nothing
          // invalidates the list while it's up -- a pull is the only way to
          // see who has liked the post since.
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <EmptyState icon="heart" title="No likes yet" body="Nobody's liked this post yet." />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { paddingVertical: 8 },
});
