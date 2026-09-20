import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { EmptyState } from '../../components/EmptyState';
import { UserRow } from '../../components/UserRow';
import { formatCommentAge } from '../../components/CommentRow';
import { useDMInbox, useDMPeers, useMyDMThreads, useProfile, type ProfileSummary } from '../../lib/queries';
import { useAuth } from '../../lib/auth';
import { hairlineWidth, useTheme } from '../../lib/theme';

/**
 * The messages landing page. ishaan sees every thread that's messaged him
 * (his real inbox); anyone else sees exactly their two possible threads --
 * ishaan, and the Drake bot -- since those are the only two accounts
 * allowed to write into someone else's thread (0008_dm.sql, 0014_dm_multi_thread.sql).
 *
 * ishaan has a bot thread too (thread_user_id = his own id, thread_with_id =
 * the bot's), the same as anyone else -- IshaanInbox surfaces it separately
 * rather than folding him into MyThreads, since "your thread with yourself"
 * (the other row MyThreads shows everyone else) isn't a real thing for him.
 */
export default function DMInbox() {
  const { profile: me } = useAuth();
  return me?.username === 'ishaan' ? <IshaanInbox /> : <MyThreads />;
}

function IshaanInbox() {
  const { profile: me } = useAuth();
  const router = useRouter();
  const { data: threads, isLoading, isError, error, refetch } = useDMInbox();
  // ishaan's own conversation with the bot -- a normal dm_messages thread
  // like anyone else's (thread_user_id = his id), but dm_inbox() above only
  // ever returns threads *addressed to* him (thread_with_id = his id), so it
  // never appears there. Fetched the same way MyThreads gets it for a
  // regular user, and not gated on `threads`/`isLoading` above: a slow
  // bot-thread fetch shouldn't hold up the admin inbox he actually uses more.
  const { data: myThreads } = useMyDMThreads();
  const { data: bot } = useProfile('prosecco_daddy');
  const { colors } = useTheme();

  const botRow = bot ? (
    <View style={[styles.ownThread, { borderBottomColor: colors.border }]}>
      <UserRow
        profile={bot}
        onPress={() => router.push(`/dm/${bot.username}?own=1`)}
        unread={myThreads?.get(bot.id)?.has_unread ?? false}
        accessory={
          (() => {
            const latest = myThreads?.get(bot.id);
            return latest ? (
              <View style={styles.preview}>
                <Text
                  style={[
                    styles.previewBody,
                    { color: latest.has_unread ? colors.text : colors.textSecondary },
                    latest.has_unread && styles.previewUnread,
                  ]}
                  numberOfLines={1}
                >
                  {latest.sender_id === me?.id ? 'You: ' : ''}
                  {latest.body}
                </Text>
                <Text style={[styles.previewAge, { color: colors.textSecondary }]}>
                  {formatCommentAge(latest.created_at)}
                </Text>
              </View>
            ) : (
              <Text style={[styles.previewBody, { color: colors.textSecondary }]}>Say hi</Text>
            );
          })()
        }
      />
    </View>
  ) : null;

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator />
      </View>
    );
  }

  // Without this a failed load renders the empty-inbox state below, which
  // tells someone with a full inbox that nobody has messaged them.
  if (isError) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <EmptyState
          icon="alert-circle"
          title="Couldn't load messages"
          body={error instanceof Error ? error.message : 'Something went wrong.'}
          actionLabel="Try again"
          onAction={() => refetch()}
        />
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
        ListHeaderComponent={botRow}
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
            unread={item.has_unread}
            accessory={
              <View style={styles.preview}>
                <Text
                  style={[
                    styles.previewBody,
                    { color: item.has_unread ? colors.text : colors.textSecondary },
                    item.has_unread && styles.previewUnread,
                  ]}
                  numberOfLines={1}
                >
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

/**
 * Everyone but ishaan: ishaan, the Drake bot, plus one row per sandboxed
 * peer (0027_dm_peer_sandbox.sql) -- still not a general inbox, just a
 * slightly longer fixed list for the handful of accounts explicitly
 * allowlisted to DM each other directly.
 */
function MyThreads() {
  const { profile: me } = useAuth();
  const router = useRouter();
  const { colors } = useTheme();
  const {
    data: latestByThread,
    isLoading: threadsLoading,
    isError: threadsError,
    refetch: refetchThreads,
  } = useMyDMThreads();
  const {
    data: ishaan,
    isLoading: ishaanLoading,
    isError: ishaanError,
    refetch: refetchIshaan,
  } = useProfile('ishaan');
  const {
    data: bot,
    isLoading: botLoading,
    isError: botError,
    refetch: refetchBot,
  } = useProfile('prosecco_daddy');
  // Empty for almost everyone -- only returns rows for accounts in
  // dm_peer_pairs. Not gated into the loading/error guards below: a slow or
  // failed peer lookup shouldn't block the two rows everyone always has.
  const { data: peers } = useDMPeers();

  // Both rows are built from these two profile lookups, so if either fails
  // there is nothing to render -- and the guard below can't tell that apart
  // from "still loading" (isLoading goes false, the data never arrives), so
  // this screen used to spin forever on a dropped connection.
  if (ishaanError || botError || threadsError) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <EmptyState
          icon="alert-circle"
          title="Couldn't load messages"
          body="Check your connection and try again."
          actionLabel="Try again"
          onAction={() => {
            refetchIshaan();
            refetchBot();
            refetchThreads();
          }}
        />
      </View>
    );
  }

  if (threadsLoading || ishaanLoading || botLoading || !ishaan || !bot) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator />
      </View>
    );
  }

  const rows: ProfileSummary[] = [ishaan, bot, ...(peers ?? [])];

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
            unread={latest?.has_unread ?? false}
            accessory={
              latest ? (
                <View style={styles.preview}>
                  <Text
                    style={[
                      styles.previewBody,
                      { color: latest.has_unread ? colors.text : colors.textSecondary },
                      latest.has_unread && styles.previewUnread,
                    ]}
                    numberOfLines={1}
                  >
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
  previewUnread: { fontWeight: '700' },
  previewAge: { fontSize: 11, marginTop: 2 },
  // Separated from the admin list below it with a hairline -- it isn't one
  // of the "people who've messaged you" rows the empty state below refers
  // to, it's ishaan's own conversation, so it needed to read as its own thing.
  ownThread: { borderBottomWidth: hairlineWidth },
});
