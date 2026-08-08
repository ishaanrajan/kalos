import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Avatar } from '../../components/Avatar';
import { EmptyState } from '../../components/EmptyState';
import { useActivity } from '../../lib/queries';
import { avatarUrl, photoUrl } from '../../lib/supabase';
import type { ActivityEvent } from '../../lib/types';

/**
 * Activity is a plain chronological log of things people did to your posts.
 * No "suggested for you", no re-engagement nudges, no notifications invented
 * by the app to pull you back in.
 */
export default function Activity() {
  const router = useRouter();
  const { data, isLoading } = useActivity();

  if (isLoading) {
    return (
      <SafeAreaView style={styles.center} edges={['top']}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Activity</Text>
      </View>

      <FlatList
        data={data ?? []}
        keyExtractor={(e, i) => `${e.kind}-${e.created_at}-${i}`}
        ListEmptyComponent={
          <EmptyState
            icon="heart"
            title="Nothing yet"
            body="Likes and comments on your photos will show up here."
          />
        }
        renderItem={({ item }) => <ActivityRow event={item} router={router} />}
      />
    </SafeAreaView>
  );
}

function ActivityRow({
  event,
  router,
}: {
  event: ActivityEvent;
  router: ReturnType<typeof useRouter>;
}) {
  const target =
    event.kind === 'follow' ? `/profile/${event.actor.username}` : `/post/${event.post_id}`;

  return (
    <Pressable style={styles.row} onPress={() => router.push(target as never)}>
      <Avatar url={avatarUrl(event.actor.avatar_path)} username={event.actor.username} size={40} />
      <Text style={styles.text} numberOfLines={2}>
        <Text style={styles.username}>{event.actor.username}</Text>
        {event.kind === 'like' && ' liked your photo.'}
        {event.kind === 'comment' && ` commented: ${event.body}`}
        {event.kind === 'follow' && ' started following you.'}
      </Text>
      {event.kind !== 'follow' && (
        <Image source={{ uri: photoUrl(event.image_path) }} style={styles.thumb} contentFit="cover" />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  header: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#dbdbdb',
  },
  title: { fontSize: 17, fontWeight: '600', color: '#262626' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  text: { flex: 1, fontSize: 14, color: '#262626', lineHeight: 19 },
  username: { fontWeight: '600' },
  thumb: { width: 44, height: 44, backgroundColor: '#efefef' },
});
