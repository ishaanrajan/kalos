import { ActivityIndicator, FlatList, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { EmptyState } from '../../components/EmptyState';
import { UserRow } from '../../components/UserRow';
import { useLikers } from '../../lib/queries';
import { useTheme } from '../../lib/theme';

/** Who liked a post — the people behind the like count. */
export default function Likes() {
  const router = useRouter();
  const { postId } = useLocalSearchParams<{ postId: string }>();
  const { data: people, isLoading } = useLikers(postId);
  const { colors } = useTheme();

  return (
    <View style={[styles.root, { backgroundColor: colors.surface }]}>
      <Stack.Screen options={{ title: 'Likes' }} />

      {isLoading ? (
        <View style={[styles.center, { backgroundColor: colors.surface }]}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={people ?? []}
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => (
            <UserRow profile={item} onPress={() => router.push(`/profile/${item.username}`)} />
          )}
          contentContainerStyle={styles.list}
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
