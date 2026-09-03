import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Redirect, Stack, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { EmptyState } from '../../components/EmptyState';
import { UserRow } from '../../components/UserRow';
import { formatCommentAge } from '../../components/CommentRow';
import { useDMInbox } from '../../lib/queries';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';

/**
 * ishaan's inbox — every thread that's messaged him, most recent first.
 * Meaningless for anyone else, so anyone who isn't ishaan gets bounced
 * straight to their own (only) thread instead.
 */
export default function DMInbox() {
  const { profile: me } = useAuth();
  const router = useRouter();
  const { data: threads, isLoading } = useDMInbox();
  const { colors } = useTheme();

  if (me && me.username !== 'ishaan') {
    return <Redirect href="/dm/ishaan" />;
  }

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              onPress={() => router.push('/search?intent=dm')}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="New message"
            >
              <Feather name="edit" size={20} color={colors.text} />
            </Pressable>
          ),
        }}
      />
      <FlatList
        style={[styles.root, { backgroundColor: colors.surface }]}
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
                <Text style={[styles.previewBody, { color: colors.textSecondary }]} numberOfLines={1}>
                  {item.last_sender_id === me?.id ? 'You: ' : ''}
                  {item.last_body}
                </Text>
                <Text style={[styles.previewAge, { color: colors.textSecondary }]}>
                  {formatCommentAge(item.last_created_at)}
                </Text>
              </View>
            }
          />
        )}
      />
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  preview: { alignItems: 'flex-end', maxWidth: 110 },
  previewBody: { fontSize: 12 },
  previewAge: { fontSize: 11, marginTop: 2 },
});
