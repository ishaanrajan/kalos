import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { EmptyState } from '../../components/EmptyState';
import { UserRow } from '../../components/UserRow';
import { formatCommentAge } from '../../components/CommentRow';
import { useDMInbox } from '../../lib/queries';
import { useAuth } from '../../lib/auth';

/**
 * ishaan's inbox — every thread that's messaged him, most recent first.
 * Meaningless for anyone else, so anyone who isn't ishaan gets bounced
 * straight to their own (only) thread instead.
 */
export default function DMInbox() {
  const { profile: me } = useAuth();
  const router = useRouter();
  const { data: threads, isLoading } = useDMInbox();

  if (me && me.username !== 'ishaan') {
    return <Redirect href="/dm/ishaan" />;
  }

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.root}
      data={threads ?? []}
      keyExtractor={(t) => t.thread_user_id}
      ListEmptyComponent={
        <EmptyState icon="send" title="No messages yet" body="Threads people start with you show up here." />
      }
      renderItem={({ item }) => (
        <UserRow
          profile={{
            id: item.thread_user_id,
            username: item.username,
            display_name: item.display_name,
            avatar_path: item.avatar_path,
          }}
          onPress={() => router.push(`/dm/${item.username}`)}
          accessory={
            <View style={styles.preview}>
              <Text style={styles.previewBody} numberOfLines={1}>
                {item.last_sender_id === me?.id ? 'You: ' : ''}
                {item.last_body}
              </Text>
              <Text style={styles.previewAge}>{formatCommentAge(item.last_created_at)}</Text>
            </View>
          }
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  preview: { alignItems: 'flex-end', maxWidth: 110 },
  previewBody: { fontSize: 12, color: '#8e8e8e' },
  previewAge: { fontSize: 11, color: '#c7c7c7', marginTop: 2 },
});
