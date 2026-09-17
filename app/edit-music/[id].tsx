import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { MusicPicker } from '../../components/MusicPicker';
import { EmptyState } from '../../components/EmptyState';
import { usePost, useUpdatePostMusic } from '../../lib/queries';
import { useUserId } from '../../lib/auth';
import { useMusic } from '../../lib/audio';
import { postMusicToTrack, trackToPostMusic } from '../../lib/music';
import type { Track } from '../../lib/music';
import { useTheme } from '../../lib/theme';

/**
 * Adding, changing, or removing an existing post's music -- reached from the
 * post's own options sheet, same shape as edit-caption.tsx (a Stack header
 * with Done, not a save button buried in content). The picker itself is the
 * same MusicPicker the composer's music step uses; only what happens on Done
 * differs -- a mutation against an existing row instead of a field on a job
 * that hasn't been posted yet.
 */
export default function EditMusic() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const userId = useUserId();
  const { width } = useWindowDimensions();
  const { data: post, isLoading, isError, error, refetch } = usePost(id);
  const updateMusic = useUpdatePostMusic();
  const { stop: stopMusic } = useMusic();
  const { colors, typography } = useTheme();

  const [track, setTrack] = useState<Track | null>(null);
  const [startMs, setStartMs] = useState(0);
  const [initialized, setInitialized] = useState(false);

  // usePost() resolves after this screen has already mounted -- seed the
  // picker from the post's current music once it loads, but only once, so a
  // refetch mid-edit can't stomp on a track already chosen here.
  if (post && !initialized) {
    if (post.music) {
      setTrack(postMusicToTrack(post.music));
      setStartMs(post.music.start_ms);
    }
    setInitialized(true);
  }

  // Auditioning a track in the picker plays through the shared music
  // context -- leaving this screen without stopping it would keep a preview
  // playing under whatever's next, the same reasoning new.tsx's music step
  // stops on its own Back/Done.
  useFocusEffect(
    useCallback(() => {
      return () => stopMusic();
    }, [stopMusic]),
  );

  function save() {
    if (!post) return;
    updateMusic.mutate(
      { postId: post.id, music: track ? trackToPostMusic(track, startMs) : null },
      {
        onSuccess: () => {
          stopMusic();
          router.back();
        },
        onError: (e) => Alert.alert('Could not save', e instanceof Error ? e.message : undefined),
      },
    );
  }

  if (isError) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <EmptyState
          icon="alert-circle"
          title="Couldn't load this post"
          body={error instanceof Error ? error.message : 'Something went wrong.'}
          actionLabel="Try again"
          onAction={() => refetch()}
        />
      </View>
    );
  }

  if (isLoading || !post) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator />
      </View>
    );
  }

  // Only the author should ever land here -- PostCard only offers this
  // option on your own posts, but the route itself has no way to know that
  // without checking, since it's reachable by URL.
  if (post.author.id !== userId) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <Text style={{ color: colors.text }}>You can only edit your own posts.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.surface }]}>
      <Stack.Screen
        options={{
          title: post.music ? 'Edit music' : 'Add music',
          headerRight: () =>
            updateMusic.isPending ? (
              <ActivityIndicator size="small" />
            ) : (
              <Pressable onPress={save} hitSlop={12}>
                <Text style={[typography.bodyStrong, { color: colors.accent }]}>Done</Text>
              </Pressable>
            ),
        }}
      />

      <MusicPicker
        selected={track}
        startMs={startMs}
        onChangeSelected={setTrack}
        onChangeStartMs={setStartMs}
        width={width}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
