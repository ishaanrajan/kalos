import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { EmptyState } from '../../components/EmptyState';
import { UserRow } from '../../components/UserRow';
import { formatCommentAge } from '../../components/CommentRow';
import { useDMInbox, useMyDMThreads, useProfile } from '../../lib/queries';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';
import type { Profile } from '../../lib/types';

/**
 * The messages landing page. ishaan sees every thread that's messaged him
 * (his real inbox); anyone else sees exactly their two possible threads --
 * ishaan, and the Drake bot -- since those are the only two accounts
 * allowed to write into someone else's thread (0008_dm.sql, 0014_dm_multi_thread.sql).
 */
export default function DMInbox() {
  const { profile: me } = useAuth();
  return me?.username === 'ishaan' ? <IshaanInbox /> : <MyThreads />;
}

function IshaanInbox() {
  const { profile: me } = useAuth();
  const router = useRouter();
  const { data: threads, isLoading } = useDMInbox();
  const { colors } = useTheme();

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

/** Everyone but ishaan: a fixed two-row list, not a general inbox. */
function MyThreads() {
  const { profile: me } = useAuth();
  const router = useRouter();
  const { colors } = useTheme();
  const { data: latestByThread, isLoading: threadsLoading } = useMyDMThreads();
  const { data: ishaan, isLoading: ishaanLoading } = useProfile('ishaan');
  const { data: bot, isLoading: botLoading } = useProfile('prosecco_daddy');

  if (threadsLoading || ishaanLoading || botLoading || !ishaan || !bot) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator />
      </View>
    );
  }

  const rows: Profile[] = [ishaan, bot];

  return (
    <FlatList
      style={[styles.root, { backgroundColor: colors.surface }]}
      data={rows}
      keyExtractor={(p) => p.id}
      renderItem={({ item }) => {
        const latest = latestByThread?.get(item.id);
        return (
          <UserRow
            profile={item}
            onPress={() => router.push(`/dm/${item.username}`)}
            accessory={
              latest ? (
                <View style={styles.preview}>
                  <Text style={[styles.previewBody, { color: colors.textSecondary }]} numberOfLines={1}>
                    {latest.sender_id === me?.id ? 'You: ' : ''}
                    {latest.body}
                  </Text>
                  <Text style={[styles.previewAge, { color: colors.textSecondary }]}>
                    {formatCommentAge(latest.created_at)}
                  </Text>
                </View>
              ) : (
                <Text style={[styles.previewBody, { color: colors.textSecondary }]}>Say hi</Text>
              )
            }
          />
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  preview: { alignItems: 'flex-end', maxWidth: 110 },
  previewBody: { fontSize: 12 },
  previewAge: { fontSize: 11, marginTop: 2 },
});
