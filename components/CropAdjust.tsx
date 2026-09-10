/**
 * Pinch-to-zoom + pan crop step, shown after a photo's picked and before the
 * filter step -- restores the reframing control that went away when the
 * OS's own edit/crop screen was dropped in favor of the in-app library grid
 * (that native screen is tied to expo-image-picker's own flow, not
 * something that can be bolted onto an arbitrary already-selected photo).
 *
 * The frame's aspect ratio is fixed for the whole gesture (matches
 * PostCard's own displayAspectRatio() clamp, computed by the caller). Pinch
 * only zooms in from the frame's own "cover" baseline (scale >= 1, capped at
 * 4x) -- there's nothing to zoom "out" to since the baseline already fills
 * the frame. Pan is clamped so the image can never reveal empty space past
 * its own edge.
 */

import { forwardRef, useImperativeHandle, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import type { CropRect, ImageSize } from '../lib/types';

const MAX_ZOOM = 4;

export interface CropAdjustHandle {
  /** The currently framed region, in the original photo's own pixel space. */
  getCropRect: () => CropRect;
}

export interface CropAdjustProps {
  /** Doesn't need to be full-resolution -- this is a live gesture surface,
   * not the bake source. The composer preview copy is plenty. */
  uri: string;
  /** The photo's real pixel dimensions -- the crop rect this exposes is in this space. */
  natural: ImageSize;
  /** Width/height of the visible frame, in points. */
  frame: ImageSize;
}

export const CropAdjust = forwardRef<CropAdjustHandle, CropAdjustProps>(function CropAdjust(
  { uri, natural, frame },
  ref
) {
  // "Cover" baseline: the smallest size, at scale 1, that fully fills the
  // frame with no gaps.
  const base = useMemo<ImageSize>(() => {
    const imageAspect = natural.width / natural.height;
    const frameAspect = frame.width / frame.height;
    return imageAspect > frameAspect
      ? { width: frame.height * imageAspect, height: frame.height }
      : { width: frame.width, height: frame.width / imageAspect };
  }, [natural.width, natural.height, frame.width, frame.height]);

  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  // Rule-of-thirds lines, shown only while a gesture is actually live -- a
  // static overlay reads as decoration; one that appears with your finger
  // reads as the tool telling you it's tracking you, the same cue every
  // native photo-crop UI gives.
  const gridOpacity = useSharedValue(0);

  // How far the image can be panned off-center, in points, at the given
  // scale, before its own edge would enter the frame.
  function maxOffset(s: number) {
    'worklet';
    return {
      x: Math.max(0, (base.width * s - frame.width) / 2),
      y: Math.max(0, (base.height * s - frame.height) / 2),
    };
  }

  const pan = Gesture.Pan()
    .onStart(() => {
      startX.value = translateX.value;
      startY.value = translateY.value;
      gridOpacity.value = withTiming(1, { duration: 120 });
    })
    .onUpdate((e) => {
      const m = maxOffset(scale.value);
      translateX.value = Math.min(m.x, Math.max(-m.x, startX.value + e.translationX));
      translateY.value = Math.min(m.y, Math.max(-m.y, startY.value + e.translationY));
    })
    .onFinalize(() => {
      gridOpacity.value = withDelay(200, withTiming(0, { duration: 250 }));
    });

  const pinch = Gesture.Pinch()
    .onStart(() => {
      startScale.value = scale.value;
      gridOpacity.value = withTiming(1, { duration: 120 });
    })
    .onUpdate((e) => {
      scale.value = Math.max(1, Math.min(MAX_ZOOM, startScale.value * e.scale));
      // Re-clamp translate against the new scale -- without this, zooming
      // back out while panned to an edge would leave a gap the pan gesture
      // alone would never get a chance to correct.
      const m = maxOffset(scale.value);
      translateX.value = Math.min(m.x, Math.max(-m.x, translateX.value));
      translateY.value = Math.min(m.y, Math.max(-m.y, translateY.value));
    })
    .onFinalize(() => {
      gridOpacity.value = withDelay(200, withTiming(0, { duration: 250 }));
    });

  // A quick double-tap resets to the "cover" baseline -- the one thing a
  // pinch-only crop can't do for you once you're zoomed in and have lost
  // track of where "reset" even is. Tap needs no finger travel and Pan
  // requires some, so Race lets a genuine double-tap win outright without
  // a stray pixel of drag ever reaching the pan gesture above.
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scale.value = withTiming(1, { duration: 200 });
      translateX.value = withTiming(0, { duration: 200 });
      translateY.value = withTiming(0, { duration: 200 });
    });

  const gesture = Gesture.Race(doubleTap, Gesture.Simultaneous(pan, pinch));

  const imageStyle = useAnimatedStyle(() => ({
    width: base.width,
    height: base.height,
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const gridStyle = useAnimatedStyle(() => ({ opacity: gridOpacity.value }));

  useImperativeHandle(
    ref,
    () => ({
      getCropRect: () => {
        // A plain JS read, not a worklet -- this runs once, from the "Next"
        // button's press handler, not per gesture frame. Shared values are
        // just as readable from the JS thread as from a worklet.
        const s = scale.value;
        const displayedW = base.width * s;
        const displayedH = base.height * s;
        const scaleToSource = natural.width / displayedW;
        return {
          x: (displayedW / 2 - frame.width / 2 - translateX.value) * scaleToSource,
          y: (displayedH / 2 - frame.height / 2 - translateY.value) * scaleToSource,
          width: frame.width * scaleToSource,
          height: frame.height * scaleToSource,
        };
      },
    }),
    [base.width, base.height, frame.width, frame.height, natural.width, scale, translateX, translateY]
  );

  return (
    <View style={[styles.frame, { width: frame.width, height: frame.height }]}>
      <GestureDetector gesture={gesture}>
        <Animated.View style={imageStyle}>
          <Image source={uri} style={styles.image} contentFit="fill" />
        </Animated.View>
      </GestureDetector>
      <Animated.View style={[styles.gridOverlay, gridStyle]} pointerEvents="none">
        <View style={[styles.gridLine, styles.gridLineV, { left: '33.333%' }]} />
        <View style={[styles.gridLine, styles.gridLineV, { left: '66.666%' }]} />
        <View style={[styles.gridLine, styles.gridLineH, { top: '33.333%' }]} />
        <View style={[styles.gridLine, styles.gridLineH, { top: '66.666%' }]} />
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: '#000' },
  image: { width: '100%', height: '100%' },
  gridOverlay: { ...StyleSheet.absoluteFill },
  gridLine: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.65)' },
  gridLineV: { top: 0, bottom: 0, width: StyleSheet.hairlineWidth },
  gridLineH: { left: 0, right: 0, height: StyleSheet.hairlineWidth },
});

export default CropAdjust;
