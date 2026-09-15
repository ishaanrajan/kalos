import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Avatar } from '../../components/Avatar';
import { EmptyState } from '../../components/EmptyState';
import { MentionText } from '../../components/MentionText';
import { useActivity, useMarkActivityRead } from '../../lib/queries';
import { avatarUrl, photoThumbUrl } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';
import type { ActivityEvent } from '../../lib/types';

/**
 * Activity is a plain chronological log of things people did to your posts.
 * No "suggested for you", no re-engagement nudges, no notifications invented
 * by the app to pull you back in.
 */
export default function Activity() {
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useActivity();
  const { refreshProfile } = useAuth();
  const markRead = useMarkActivityRead();
  const { colors } = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  // Opening this tab is what "read" means here. This has to be tied to
  // *focus*, not mount: bottom-tab screens mount on first focus and are never
  // unmounted (no unmountOnBlur in (tabs)/_layout.tsx), so a mount effect ran
  // exactly once per app launch. Open Activity at 9am, get a like at 10am --
  // useActivity refetches on focus and lights the red dot, but returning to
  // this already-mounted tab re-ran nothing, so activity_read_at never
  // advanced and the dot stayed lit for the rest of the session.
  //
  // The callback deliberately takes no dependencies: markRead is a new object
  // every render, and depending on it would re-fire the effect mid-focus.
  // AuthContext's profile is separate state from react-query's cache, so the
  // mutation's own invalidation doesn't touch it -- refresh it explicitly or
  // the red dot (driven by profile.activity_read_at) never clears.
  //
  // The refetch is here for the same reason: useActivity only refetches on
  // app foreground or when a push arrives, so with notifications off a like
  // that landed while you were on Home didn't show up by switching to this
  // tab. The pull-to-refresh below is the manual version of the same thing.
  useFocusEffect(
    useCallback(() => {
      markRead.mutate(undefined, { onSuccess: () => refreshProfile() });
      void refetch();
    }, [])
  );

  if (isLoading) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: colors.surface }]} edges={['top']}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.text }]}>Activity</Text>
      </View>

      <FlatList
        data={data ?? []}
        keyExtractor={(e, i) => `${e.kind}-${e.created_at}-${i}`}
        ListEmptyComponent={
          isError ? (
            <EmptyState
              icon="alert-circle"
              title="Couldn't load activity"
              actionLabel="Try again"
              onAction={() => refetch()}
            />
          ) : (
            <EmptyState
              icon="heart"
              title="Nothing yet"
              body="Likes, comments and tags will show up here."
            />
          )
        }
        renderItem={({ item }) => <ActivityRow event={item} router={router} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      />
    </SafeAreaView>
  );
}

/** One sentence for VoiceOver -- the row's nested Texts read as fragments otherwise. */
function describe(event: ActivityEvent): string {
  switch (event.kind) {
    case 'like':
      return `${event.actor.username} liked your photo`;
    case 'comment':
      return `${event.actor.username} commented: ${event.body}`;
    case 'follow':
      return `${event.actor.username} started following you`;
    case 'mention':
      return `${event.actor.username} mentioned you: ${event.body}`;
    case 'tag':
      return `${event.actor.username} tagged you in a photo`;
  }
}

function ActivityRow({
  event,
  router,
}: {
  event: ActivityEvent;
  router: ReturnType<typeof useRouter>;
}) {
  const { colors } = useTheme();
  const target =
    event.kind === 'follow' ? `/profile/${event.actor.username}` : `/post/${event.post_id}`;

  return (
    <Pressable
      style={styles.row}
      onPress={() => router.push(target as never)}
      accessibilityRole="button"
      accessibilityLabel={describe(event)}
    >
      <Avatar url={avatarUrl(event.actor.avatar_path)} username={event.actor.username} size={40} />
      <Text style={[styles.text, { color: colors.text }]} numberOfLines={2}>
        <Text style={styles.username}>{event.actor.username}</Text>
        {event.kind === 'like' && ' liked your photo.'}
        {event.kind === 'comment' && ` commented: ${event.body}`}
        {event.kind === 'follow' && ' started following you.'}
        {event.kind === 'tag' && ' tagged you in a photo.'}
        {event.kind === 'mention' && (
          <>
            {' mentioned you: '}
            <MentionText
              text={event.body}
              mentionColor={colors.mention}
              onPressMention={(username) => router.push(`/profile/${username}`)}
            />
          </>
        )}
      </Text>
      {event.kind !== 'follow' && (
        <Image
          // The grid derivative, not the full-size original -- 50 rows of
          // 44pt thumbs were fetching 50 feed-sized JPEGs.
          source={{ uri: photoThumbUrl({ image_path: event.image_path, thumb_path: event.thumb_path ?? null }) }}
          style={[styles.thumb, { backgroundColor: colors.imagePlaceholder }]}
          contentFit="cover"
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  text: { flex: 1, fontSize: 14, lineHeight: 19 },
  username: { fontWeight: '600' },
  thumb: { width: 44, height: 44 },
});
