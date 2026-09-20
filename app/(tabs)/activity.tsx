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
import type { ActivityTab } from '../../lib/queries';
import { avatarUrl, photoThumbUrl } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { typography, useTheme } from '../../lib/theme';
import type { ActivityEvent } from '../../lib/types';

/**
 * Activity is a plain chronological log of things people did to your posts.
 * No "suggested for you", no re-engagement nudges, no notifications invented
 * by the app to pull you back in.
 */
export default function Activity() {
  const router = useRouter();
  const [tab, setTab] = useState<ActivityTab>('you');
  const { data, isLoading, isError, refetch } = useActivity(tab);
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

      {/* 2015 Instagram's own split under the same heart icon: FOLLOWING is
          what people you follow are doing on posts generally, YOU is what's
          happened on your own -- two different questions, not a filter on
          one feed. Order matches the reference (FOLLOWING first). */}
      <View style={[styles.tabs, { borderBottomColor: colors.border }]}>
        <SegmentTab label="Following" active={tab === 'following'} onPress={() => setTab('following')} />
        <SegmentTab label="You" active={tab === 'you'} onPress={() => setTab('you')} />
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
          ) : tab === 'you' ? (
            <EmptyState
              icon="camera"
              title="Recent Activity on your posts"
              body="When someone comments on or likes one of your photos or videos, you'll see it here."
              actionLabel="Post a photo"
              onAction={() => router.push('/(tabs)/new')}
            />
          ) : (
            <EmptyState
              icon="users"
              title="Activity from people you follow"
              body="When someone you follow comments on or likes a post, you'll see it here."
              actionLabel="Find People to Follow"
              onAction={() => router.push('/search')}
            />
          )
        }
        renderItem={({ item }) => <ActivityRow event={item} tab={tab} router={router} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      />
    </SafeAreaView>
  );
}

/**
 * One sentence for VoiceOver -- the row's nested Texts read as fragments
 * otherwise. `tab` matters for `like`: on FOLLOWING it's never the viewer's
 * own photo (the RPC excludes those rows), so "liked your photo" would be
 * flatly wrong there. `comment`/`follow`/`mention`/`tag` don't need the
 * distinction -- the latter three never appear outside the YOU tab at all,
 * and "commented: {body}" doesn't claim ownership either way.
 */
function describe(event: ActivityEvent, tab: ActivityTab): string {
  switch (event.kind) {
    case 'like':
      return tab === 'you'
        ? `${event.actor.username} liked your photo`
        : `${event.actor.username} liked a photo`;
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
  tab,
  router,
}: {
  event: ActivityEvent;
  tab: ActivityTab;
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
      accessibilityLabel={describe(event, tab)}
    >
      <Avatar url={avatarUrl(event.actor.avatar_path)} username={event.actor.username} size={40} />
      <Text style={[styles.text, { color: colors.text }]} numberOfLines={2}>
        <Text style={styles.username}>{event.actor.username}</Text>
        {event.kind === 'like' && (tab === 'you' ? ' liked your photo.' : ' liked a photo.')}
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

/** FOLLOWING / YOU, styled like the tab bar on the follows list -- an
 *  underline, not a filled pill, matching this app's 2015 chrome. */
function SegmentTab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      style={[styles.tab, { borderBottomColor: active ? colors.text : 'transparent' }]}
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
    >
      <Text
        style={[
          typography.timestamp,
          styles.tabText,
          { color: active ? colors.text : colors.textSecondary },
          active && styles.tabTextActive,
        ]}
      >
        {label}
      </Text>
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
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  // typography.timestamp already gives the uppercase/letterspaced look;
  // this just bumps it up from a caption's own tiny size to a legible tab
  // label.
  tabText: { fontSize: 12 },
  tabTextActive: { fontWeight: '700' },
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
