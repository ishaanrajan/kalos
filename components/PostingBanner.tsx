/**
 * The strip that sits under the Home header while a post is uploading -- the
 * thumbnail, "Posting…", and a sweeping progress bar -- and, if the upload
 * fails, the same row with Retry and Discard in place of the bar. Rendered
 * from lib/postUpload's state, so it appears the instant Share is tapped
 * and disappears on its own once the post is in the feed.
 *
 * The bar is indeterminate on purpose: Supabase's upload API reports no
 * progress, and a bar that pretends to know is worse than one that
 * honestly says "working on it".
 */

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import Feather from '@expo/vector-icons/Feather';

import { discardFailedPost, retryPost, usePostUploadState } from '../lib/postUpload';
import { hairlineWidth, spacing, radius, useTheme } from '../lib/theme';

const THUMB = 36;
const BAR_HEIGHT = 3;
/** The sweeping bar's length as a fraction of the track. */
const BAR_FRACTION = 0.35;

export function PostingBanner() {
  const state = usePostUploadState();
  const { colors, typography } = useTheme();

  if (state.status === 'idle') return null;

  const failed = state.status === 'error';
  return (
    <View
      style={[styles.root, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.row}>
        <Image
          source={state.job.previewUri}
          style={[styles.thumb, { backgroundColor: colors.imagePlaceholder }]}
          contentFit="cover"
          accessible={false}
        />
        <View style={styles.text}>
          <Text style={[typography.bodyStrong, { color: colors.text }]} numberOfLines={1}>
            {failed ? 'Couldn’t post' : 'Posting…'}
          </Text>
          {failed ? (
            <Text style={[typography.meta, { color: colors.textSecondary }]} numberOfLines={2}>
              {`Failed while ${state.stage}. ${firstLine(state.message)}`}
            </Text>
          ) : null}
        </View>
        {failed ? (
          <View style={styles.actions}>
            <Pressable
              onPress={() => {
                void retryPost();
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Retry posting"
            >
              <Text style={[typography.metaStrong, { color: colors.accent }]}>Retry</Text>
            </Pressable>
            <Pressable
              onPress={discardFailedPost}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Discard this post"
            >
              <Feather name="x" size={18} color={colors.textSecondary} />
            </Pressable>
          </View>
        ) : null}
      </View>
      {failed ? null : <IndeterminateBar color={colors.accent} track={colors.surfaceAlt} />}
    </View>
  );
}

function firstLine(message: string): string {
  return message.split('\n')[0] ?? '';
}

/** A short bar sweeping left to right on loop. */
function IndeterminateBar({ color, track }: { color: string; track: string }) {
  const progress = useRef(new Animated.Value(0)).current;
  const [trackWidth, setTrackWidth] = useState(0);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1100,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [progress]);

  return (
    <View
      style={[styles.track, { backgroundColor: track }]}
      onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
    >
      {trackWidth > 0 ? (
        <Animated.View
          style={[
            styles.bar,
            { backgroundColor: color, width: trackWidth * BAR_FRACTION },
            {
              transform: [
                {
                  translateX: progress.interpolate({
                    inputRange: [0, 1],
                    // From fully off the left edge to fully off the right.
                    outputRange: [-trackWidth * BAR_FRACTION, trackWidth],
                  }),
                },
              ],
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { borderBottomWidth: hairlineWidth },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  thumb: { width: THUMB, height: THUMB, borderRadius: radius.sm },
  text: { flex: 1, gap: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  track: { height: BAR_HEIGHT, overflow: 'hidden' },
  bar: { position: 'absolute', left: 0, top: 0, bottom: 0 },
});
