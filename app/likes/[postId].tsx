import { ActivityIndicator, FlatList, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { EmptyState } from '../../components/EmptyState';
import { UserRow } from '../../components/UserRow';
import { useLikers } from '../../lib/queries';

/** Who liked a post — the people behind the like count. */
export default function Likes() {
  const router = useRouter();
  const { postId } = useLocalSearchParams<{ postId: string }>();
  const { data: people, isLoading } = useLikers(postId);

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: 'Likes' }} />

      {isLoading ? (
        <View style={styles.center}>
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
  root: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  list: { paddingVertical: 8 },
});
