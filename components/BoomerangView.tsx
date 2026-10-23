/**
 * Plays a boomerang: one sprite sheet, drawn one frame at a time, forward then
 * backward, looping.
 *
 * The frame never changes on the JS thread. A Reanimated frame callback keeps
 * a tick on the UI thread and two derived values translate the sheet behind a
 * clipped window, so the only per-frame work is a paint offset. That is not a
 * micro-optimisation: these play inside the feed's scrolling list, and the
 * grid-jank bug this app already fixed came from exactly this -- work landing
 * on the JS thread while a list was trying to scroll. A 15fps setInterval per
 * visible post would have walked straight back into it.
 *
 * Drawing is a translate-under-clip rather than a per-frame sub-image: the
 * whole sheet is one decoded `SkImage` that never gets rebuilt, positioned so
 * that only the current cell falls inside the canvas. Changing frame costs an
 * x/y update and nothing else -- no decode, no allocation, no texture upload.
 */

import {
  Canvas,
  ColorMatrix,
  Group,
  Image as SkiaImage,
  useImage,
  type SkImage,
} from '@shopify/react-native-skia';
import React, { useEffect, useMemo } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { useDerivedValue, useFrameCallback, useSharedValue } from 'react-native-reanimated';

import { lerpMatrix } from '../lib/filters';
import type { Filter, PostBoomerang } from '../lib/types';

export interface BoomerangViewProps {
  /** The sprite sheet: an already-decoded image, or a URI to decode. */
  image?: SkImage | string | null;
  boomerang: PostBoomerang;
  /** Rendered edge length. Frames are square, so this is width and height. */
  size: number;
  /**
   * Whether the loop is running. False parks it on frame 0 and stops the frame
   * callback entirely -- the feed passes false for anything off screen, so a
   * long scroll isn't quietly driving twenty animations nobody can see.
   */
  playing?: boolean;
  /** Optional filter, for previewing a boomerang in the composer. */
  filter?: Filter;
  strength?: number;
  style?: StyleProp<ViewStyle>;
}

export function BoomerangView({
  image,
  boomerang,
  size,
  playing = true,
  filter,
  strength = 1,
  style,
}: BoomerangViewProps): React.JSX.Element {
  const decoded = useImage(typeof image === 'string' ? image : null);
  const sheet = typeof image === 'string' ? decoded : image ?? null;

  const { frames, cols, rows, fps } = boomerang;

  const tick = useSharedValue(0);

  // Reset to the first frame whenever playback stops, so a paused boomerang in
  // the feed shows its opening frame rather than freezing mid-motion.
  useEffect(() => {
    if (!playing) tick.value = 0;
  }, [playing, tick]);

  const frameCallback = useFrameCallback((info) => {
    'worklet';
    const msPerFrame = 1000 / fps;
    tick.value = Math.floor(info.timeSinceFirstFrame / msPerFrame);
  }, false);

  useEffect(() => {
    frameCallback.setActive(!!playing && !!sheet);
  }, [frameCallback, playing, sheet]);

  // The ping-pong walk, inlined rather than calling lib/boomerang's
  // pingPongFrame: this runs on the UI thread, and a worklet can only call a
  // worklet. The arithmetic is the same -- 0..n-1 then back down to 1, so a
  // cycle is 2n-2 and neither turning point is held for two ticks.
  const offsetX = useDerivedValue(() => {
    'worklet';
    const cycle = 2 * frames - 2 > 0 ? 2 * frames - 2 : 1;
    const t = ((tick.value % cycle) + cycle) % cycle;
    const frame = t < frames ? t : cycle - t;
    return -(frame % cols) * size;
  }, [frames, cols, size]);

  const offsetY = useDerivedValue(() => {
    'worklet';
    const cycle = 2 * frames - 2 > 0 ? 2 * frames - 2 : 1;
    const t = ((tick.value % cycle) + cycle) % cycle;
    const frame = t < frames ? t : cycle - t;
    return -Math.floor(frame / cols) * size;
  }, [frames, cols, size]);

  const matrix = useMemo(
    () => (filter ? lerpMatrix(filter.matrix, strength) : null),
    [filter, strength]
  );

  return (
    <Canvas style={[{ width: size, height: size }, style]}>
      <Group
        // Clips to one cell, so the eleven frames either side of the current
        // one are simply outside the canvas.
        clip={{ x: 0, y: 0, width: size, height: size }}
      >
        {sheet ? (
          <Group layer={matrix ? <ColorMatrix matrix={matrix} /> : undefined}>
            <SkiaImage
              image={sheet}
              x={offsetX}
              y={offsetY}
              width={size * cols}
              height={size * rows}
              fit="fill"
            />
          </Group>
        ) : null}
      </Group>
    </Canvas>
  );
}

export default BoomerangView;
