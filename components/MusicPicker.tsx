/**
 * The composer's music step: search a track, then choose which slice of it
 * plays.
 *
 * Two panes in one component, because they share the selected track and the
 * live preview player. Searching is a plain debounced list; trimming is a
 * 30-second strip with a draggable MUSIC_CLIP_SECONDS window over it.
 *
 * The preview is the app's one real player (lib/audio.tsx) under a synthetic
 * post id, so a track auditioned here can't end up layered under a track
 * playing in the feed behind the composer.
 *
 * The "courtesy of iTunes" line at the bottom is not decoration -- see
 * lib/music.ts for why previews carry that obligation.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

import { useTrackSearch } from '../lib/queries';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { useMusic } from '../lib/audio';
import type { Track } from '../lib/music';
import { hairlineWidth, radius, spacing, useTheme } from '../lib/theme';
import { MUSIC_CLIP_SECONDS } from '../lib/types';

/** Every iTunes preview is 30 seconds. The strip is a picture of exactly that. */
const PREVIEW_SECONDS = 30;

/** The catalog's rate limit is per minute, so settle before spending a call. */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * How often a drag is allowed to seek the live preview. previewUrl is a
 * remote stream, not a local file -- seeking it isn't free, so doing it on
 * every gesture frame (the old behaviour: window moves live, audio silent
 * until release) would mean a seek every ~16ms, which is both wasted network
 * traffic and, on a slow connection, audibly worse than not scrubbing live at
 * all. This is loose enough to stay well clear of that while still landing on
 * a new few-hundred-ms window often enough to sound like it's tracking you.
 */
const SCRUB_SEEK_THROTTLE_MS = 150;

/**
 * Synthetic post id for the audition, so it can never collide with a real
 * post's. The track id is part of it because requestPlay ignores a request for
 * the post already playing -- with one fixed id, picking a second track would
 * be silently ignored and keep playing the first.
 */
const composerPostId = (trackId: string) => `__composer__:${trackId}`;

const STRIP_HEIGHT = 56;
const WAVEFORM_BARS = 56;

export interface MusicPickerProps {
  /** Restores the current selection when re-entering the step. */
  selected: Track | null;
  startMs: number;
  onChangeSelected: (track: Track | null) => void;
  onChangeStartMs: (startMs: number) => void;
  /** Width available for the trim strip. */
  width: number;
}

/**
 * A deterministic pseudo-waveform.
 *
 * We have no sample data -- the preview is streamed, and decoding it to draw a
 * real envelope would cost more than the affordance is worth. What the strip
 * actually has to do is give the drag somewhere to land and make two positions
 * look different from each other, and a stable per-track shape does that. It's
 * keyed off the track id so a given song always looks like itself.
 */
function waveformFor(trackId: string): number[] {
  let seed = 0;
  for (let i = 0; i < trackId.length; i++) {
    seed = (seed * 31 + trackId.charCodeAt(i)) >>> 0;
  }
  const bars: number[] = [];
  for (let i = 0; i < WAVEFORM_BARS; i++) {
    // xorshift -- cheap, and good enough to not look like a sine wave.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    bars.push(0.25 + (seed % 1000) / 1000 * 0.75);
  }
  return bars;
}

function formatOffset(ms: number): string {
  const total = Math.round(ms / 1000);
  return `0:${String(total).padStart(2, '0')}`;
}

export function MusicPicker({
  selected,
  startMs,
  onChangeSelected,
  onChangeStartMs,
  width,
}: MusicPickerProps) {
  const { colors, typography } = useTheme();
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const { data: results, isFetching, isError } = useTrackSearch(debouncedQuery);
  const { requestPlay, stop, setClipStart } = useMusic();

  const stripWidth = width - spacing.lg * 2;
  const windowWidth = (stripWidth * MUSIC_CLIP_SECONDS) / PREVIEW_SECONDS;
  const maxOffset = Math.max(0, stripWidth - windowWidth);

  const offset = useSharedValue((startMs / (PREVIEW_SECONDS * 1000)) * stripWidth);
  const startOffset = useSharedValue(0);
  // Read and written on the UI thread inside the pan worklet below, so the
  // throttle check never has to cross the bridge just to find out it should
  // do nothing.
  const lastSeekAt = useSharedValue(0);

  const selectTrack = useCallback(
    (track: Track) => {
      // Re-tapping the track that's already chosen keeps its trim. It used to
      // reset the window to 0:00 in the UI while requestPlay ignored the
      // request (same id, already active), so the loop kept playing the old
      // slice and the post saved start_ms 0 -- three different answers to
      // "where does the clip start". Still asks to play, though: if the
      // audition was stopped by leaving the composer, this is how it resumes.
      const alreadySelected = selected?.id === track.id;
      if (!alreadySelected) {
        onChangeSelected(track);
        onChangeStartMs(0);
        offset.value = 0;
      }
      requestPlay(composerPostId(track.id), {
        track_id: track.id,
        title: track.title,
        artist: track.artist,
        artwork_url: track.artworkUrl,
        preview_url: track.previewUrl,
        store_url: track.storeUrl,
        start_ms: alreadySelected ? startMs : 0,
      });
    },
    [selected, startMs, onChangeSelected, onChangeStartMs, offset, requestPlay],
  );

  const commitOffset = useCallback(
    (px: number) => {
      const ms = Math.round((px / stripWidth) * PREVIEW_SECONDS * 1000);
      onChangeStartMs(ms);
      setClipStart(ms);
    },
    [stripWidth, onChangeStartMs, setClipStart],
  );

  // Leaving the step must not leave a track playing behind the composer.
  useEffect(() => stop, [stop]);

  // Coming back to the step with a track already attached should pick the
  // audition back up, since unmounting stopped it. Mount-only on purpose:
  // selectTrack already handles every later change.
  useEffect(() => {
    if (!selected) return;
    requestPlay(composerPostId(selected.id), {
      track_id: selected.id,
      title: selected.title,
      artist: selected.artist,
      artwork_url: selected.artworkUrl,
      preview_url: selected.previewUrl,
      store_url: selected.storeUrl,
      start_ms: startMs,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => {
          startOffset.value = offset.value;
          // So the first movement of a drag always seeks immediately, rather
          // than waiting out whatever's left of the throttle window from
          // audition playback or a previous drag.
          lastSeekAt.value = 0;
        })
        .onUpdate((event) => {
          const next = startOffset.value + event.translationX;
          offset.value = Math.min(maxOffset, Math.max(0, next));
          // Throttled, not per-frame: see SCRUB_SEEK_THROTTLE_MS. The window
          // still moves every frame regardless -- only the audio catch-up is
          // rate-limited.
          const now = Date.now();
          if (now - lastSeekAt.value >= SCRUB_SEEK_THROTTLE_MS) {
            lastSeekAt.value = now;
            runOnJS(commitOffset)(offset.value);
          }
        })
        // Unconditional, not just the last throttled tick -- the window can
        // land anywhere up to SCRUB_SEEK_THROTTLE_MS after the last seek, and
        // the audio should end up exactly where the finger did, not close to it.
        .onEnd(() => {
          runOnJS(commitOffset)(offset.value);
        }),
    [offset, startOffset, maxOffset, commitOffset, lastSeekAt],
  );

  const windowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));

  const bars = useMemo(() => (selected ? waveformFor(selected.id) : []), [selected]);

  const renderResult = useCallback(
    ({ item }: { item: Track }) => (
      <Pressable
        onPress={() => selectTrack(item)}
        style={({ pressed }) => [
          styles.result,
          pressed && { backgroundColor: colors.surfaceAlt },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`${item.title} by ${item.artist}`}
      >
        <View style={[styles.artwork, { backgroundColor: colors.imagePlaceholder }]}>
          {item.artworkUrl ? (
            <Image source={item.artworkUrl} style={styles.artworkImage} contentFit="cover" />
          ) : null}
        </View>
        <View style={styles.resultText}>
          <Text style={[typography.username, { color: colors.text }]} numberOfLines={1}>
            {item.title}
          </Text>
          <Text
            style={[typography.timestamp, { color: colors.textSecondary }]}
            numberOfLines={1}
          >
            {item.artist}
          </Text>
        </View>
        {selected?.id === item.id ? (
          <Ionicons name="checkmark" size={18} color={colors.accent} />
        ) : null}
      </Pressable>
    ),
    [colors, typography, selectTrack, selected],
  );

  return (
    <View style={styles.root}>
      <View style={[styles.searchRow, { backgroundColor: colors.surfaceAlt }]}>
        <Ionicons name="search" size={15} color={colors.textSecondary} />
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder="Search for a song…"
          placeholderTextColor={colors.textSecondary}
          value={query}
          onChangeText={setQuery}
          autoFocus={!selected}
          autoCorrect={false}
          returnKeyType="search"
        />
        {query.length > 0 ? (
          <Pressable onPress={() => setQuery('')} hitSlop={8}>
            <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>

      {selected ? (
        <View style={styles.trim}>
          <View style={styles.trimHeader}>
            <Text style={[typography.username, { color: colors.text }]} numberOfLines={1}>
              {selected.title}
            </Text>
            <Pressable
              onPress={() => {
                onChangeSelected(null);
                onChangeStartMs(0);
                stop();
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Remove track"
            >
              <Ionicons name="close" size={18} color={colors.textSecondary} />
            </Pressable>
          </View>

          <GestureDetector gesture={pan}>
            <View
              style={[
                styles.strip,
                { width: stripWidth, backgroundColor: colors.surfaceAlt, borderRadius: radius.md },
              ]}
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={`Clip starts at ${formatOffset(startMs)}`}
            >
              <View style={styles.barsRow} pointerEvents="none">
                {bars.map((height, i) => (
                  <View
                    key={i}
                    style={[
                      styles.bar,
                      { height: height * (STRIP_HEIGHT - 16), backgroundColor: colors.border },
                    ]}
                  />
                ))}
              </View>

              <Animated.View
                style={[
                  styles.window,
                  windowStyle,
                  { width: windowWidth, borderColor: colors.accent, borderRadius: radius.md },
                ]}
              />
            </View>
          </GestureDetector>

          <Text style={[typography.timestamp, styles.hint, { color: colors.textSecondary }]}>
            {`${formatOffset(startMs)} · ${MUSIC_CLIP_SECONDS}s — drag to choose the part that plays`}
          </Text>
        </View>
      ) : null}

      {isError ? (
        <Text style={[typography.timestamp, styles.status, { color: colors.textSecondary }]}>
          Could not reach the music catalog.
        </Text>
      ) : null}

      <FlatList
        data={results ?? []}
        keyExtractor={(t) => t.id}
        renderItem={renderResult}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        style={styles.list}
        ListHeaderComponent={
          isFetching ? <ActivityIndicator style={styles.spinner} size="small" /> : null
        }
        ListEmptyComponent={
          // Only once a real search has come back empty -- not while it's
          // still in flight, and not before anything's been typed.
          debouncedQuery.trim() && results && !isFetching && !isError ? (
            <Text style={[typography.timestamp, styles.status, { color: colors.textSecondary }]}>
              {`No songs for “${debouncedQuery.trim()}”`}
            </Text>
          ) : null
        }
        ListFooterComponent={
          <Text style={[typography.timestamp, styles.courtesy, { color: colors.textSecondary }]}>
            Music provided courtesy of iTunes
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    height: 36,
    borderRadius: radius.md,
  },
  searchInput: { flex: 1, marginLeft: spacing.sm, fontSize: 15 },
  trim: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  trimHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  strip: {
    height: STRIP_HEIGHT,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  barsRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
  },
  bar: { width: 2, borderRadius: 1 },
  window: {
    height: STRIP_HEIGHT,
    borderWidth: 2,
    backgroundColor: 'rgba(0, 149, 246, 0.14)',
  },
  hint: { marginTop: spacing.sm },
  status: { marginHorizontal: spacing.lg, marginTop: spacing.md },
  list: { flex: 1, marginTop: spacing.md },
  spinner: { marginVertical: spacing.md },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  artwork: { width: 44, height: 44, borderRadius: radius.sm, overflow: 'hidden' },
  artworkImage: { width: '100%', height: '100%' },
  resultText: { flex: 1, marginLeft: spacing.md },
  courtesy: { textAlign: 'center', paddingVertical: spacing.xl },
});
