/**
 * The username label that sits on a photo where someone was tagged: a dark
 * pill with a small caret pointing at the spot. Used in view mode on
 * PostCard (press opens the profile) and in edit mode in the composer's
 * tag editor (press removes the tag, drag repositions it).
 *
 * The anchor is a fraction of the frame (see PostTag in lib/types.ts). The
 * pill's own size isn't known until it lays out, so it renders invisible for
 * one frame, measures, then positions itself: centered under the point,
 * flipped above it when there's no room below, and slid sideways so it
 * never leaves the photo. The caret stays on the point either way.
 *
 * Dragging (`draggable`) is composer-only -- PostCard never passes it, and
 * that path is left as the plain Pressable it always was, so feed rendering
 * (many bubbles across many cards) pays nothing for a gesture it never uses.
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { fontFamily, radius } from '../lib/theme';

export interface TagBubbleProps {
  username: string;
  /** Fraction of the frame, 0..1. */
  x: number;
  y: number;
  /** Size of the photo the bubble sits on, in points. */
  frame: { width: number; height: number };
  /** View mode -- typically opens the profile. */
  onPress?: () => void;
  /** Edit mode -- shows an "x" and turns a tap-in-place into a removal. */
  onRemove?: () => void;
  /**
   * Edit mode -- lets the bubble be dragged to a new spot. `onMove` fires
   * once, at release, with the new fraction; there's nothing to save
   * mid-drag. Tap-to-remove keeps working on the same bubble: a `Tap` and a
   * `Pan` are raced against each other, the same composition CropAdjust uses
   * for its double-tap-to-reset against its own pan/pinch.
   */
  draggable?: boolean;
  onMove?: (x: number, y: number) => void;
}

const INSET = 4;
const CARET = 8;
/** Gap between the anchor point and the pill, caret included. */
const GAP = 6;

/** Where the pill and its caret sit for a given anchor + measured pill size. */
function layoutFor(ax: number, ay: number, frame: { width: number; height: number }, pillW: number, pillH: number) {
  const below = ay + GAP + pillH <= frame.height - INSET;
  const top = below ? ay + GAP : ay - GAP - pillH;
  const left = clamp(ax - pillW / 2, INSET, Math.max(INSET, frame.width - pillW - INSET));
  // The caret tracks the anchor, not the pill, but stays inside the pill's
  // rounded corners so it never floats detached.
  const caretLeft = clamp(ax - CARET / 2, left + INSET, left + pillW - CARET - INSET);
  const caretTop = below ? top - CARET / 2 : top + pillH - CARET / 2;
  return { top, left, caretTop, caretLeft };
}

export function TagBubble(props: TagBubbleProps) {
  // Two components, not a branch inside one -- each has its own hooks, and
  // switching between them by conditionally skipping hooks in a single
  // component is exactly what the rules of hooks forbid. `draggable` never
  // actually changes for a given bubble in practice (PostCard never passes
  // it; the composer always does), but this keeps that an implementation
  // detail rather than a requirement.
  return props.draggable ? <DraggableTagBubble {...props} /> : <StaticTagBubble {...props} />;
}

function StaticTagBubble({ username, x, y, frame, onPress, onRemove }: TagBubbleProps) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!size || size.width !== width || size.height !== height) setSize({ width, height });
  };

  const ax = clamp(x, 0, 1) * frame.width;
  const ay = clamp(y, 0, 1) * frame.height;

  // Until measured, park it at the anchor invisibly so the layout pass has a
  // real width to report.
  const pillW = size?.width ?? 0;
  const pillH = size?.height ?? 0;
  const { top, left, caretTop, caretLeft } = layoutFor(ax, ay, frame, pillW, pillH);

  const handlePress = onRemove ?? onPress;

  return (
    <>
      <View
        pointerEvents="none"
        style={[styles.caret, { left: caretLeft, top: caretTop, opacity: size ? 1 : 0 }]}
      />
      <Pressable
        onLayout={onLayout}
        onPress={handlePress}
        disabled={!handlePress}
        hitSlop={6}
        style={[
          styles.pill,
          { left, top, maxWidth: Math.max(80, frame.width * 0.6), opacity: size ? 1 : 0 },
        ]}
        accessibilityRole="button"
        accessibilityLabel={onRemove ? `Remove tag ${username}` : username}
      >
        <Text style={styles.text} numberOfLines={1}>
          {username}
        </Text>
        {onRemove ? <Ionicons name="close" size={14} color="#ffffff" style={styles.close} /> : null}
      </Pressable>
    </>
  );
}

/**
 * The draggable variant. `pos` is local and starts from the tag's current
 * coordinates but doesn't track them afterwards -- this bubble's own drag is
 * the only thing that ever moves this tag, so once a drag commits, the
 * parent's state update is just an echo, not a correction. Reading `x`/`y`
 * back off props instead would mean waiting on that round trip before the
 * bubble could show where it actually landed, which is exactly the flicker
 * a controlled position would introduce for no benefit here.
 */
function DraggableTagBubble({
  username,
  x,
  y,
  frame,
  onRemove,
  onMove,
}: Pick<TagBubbleProps, 'username' | 'x' | 'y' | 'frame' | 'onRemove' | 'onMove'>) {
  const [pos, setPos] = useState({ x, y });
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!size || size.width !== width || size.height !== height) setSize({ width, height });
  };

  const ax = clamp(pos.x, 0, 1) * frame.width;
  const ay = clamp(pos.y, 0, 1) * frame.height;
  const pillW = size?.width ?? 0;
  const pillH = size?.height ?? 0;
  const { top, left, caretTop, caretLeft } = layoutFor(ax, ay, frame, pillW, pillH);

  // The live offset while a finger is on the bubble. Reset to 0 the instant
  // a drag commits (see commit(), below) -- that happens in the same JS tick
  // as the `pos` update it's being replaced by, so the two never disagree
  // about where the bubble is on screen.
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);

  const commit = (newX: number, newY: number) => {
    setPos({ x: newX, y: newY });
    dragX.value = 0;
    dragY.value = 0;
    onMove?.(newX, newY);
  };

  const gesture = useMemo(() => {
    const tap = Gesture.Tap().onEnd((_e, success) => {
      if (success && onRemove) runOnJS(onRemove)();
    });

    const pan = Gesture.Pan()
      .onUpdate((e) => {
        dragX.value = e.translationX;
        dragY.value = e.translationY;
      })
      .onEnd((e) => {
        const newX = Math.min(1, Math.max(0, pos.x + e.translationX / frame.width));
        const newY = Math.min(1, Math.max(0, pos.y + e.translationY / frame.height));
        runOnJS(commit)(newX, newY);
      });

    // Race, not Simultaneous: a stationary release resolves as the Tap
    // (removal) before Pan's minimum travel distance ever triggers, and any
    // real drag resolves as the Pan -- the same trick CropAdjust uses to let
    // a double-tap win outright over its own pan/pinch.
    return Gesture.Race(tap, pan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos.x, pos.y, frame.width, frame.height, onRemove]);

  const dragStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: dragX.value }, { translateY: dragY.value }],
  }));

  return (
    <>
      <View
        pointerEvents="none"
        style={[styles.caret, { left: caretLeft, top: caretTop, opacity: size ? 1 : 0 }]}
      />
      <GestureDetector gesture={gesture}>
        <Animated.View
          onLayout={onLayout}
          style={[
            styles.pill,
            dragStyle,
            { left, top, maxWidth: Math.max(80, frame.width * 0.6), opacity: size ? 1 : 0 },
          ]}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${username}. Drag to reposition, tap to remove.`}
        >
          <Text style={styles.text} numberOfLines={1}>
            {username}
          </Text>
          {onRemove ? <Ionicons name="close" size={14} color="#ffffff" style={styles.close} /> : null}
        </Animated.View>
      </GestureDetector>
    </>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Fixed colours, not the theme's: these sit on a photo, not on the card, and
// have to read over a white sky and a black one alike.
const SCRIM = 'rgba(0, 0, 0, 0.75)';

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    // radius.pill (999) is intentionally past the pill's own height -- RN
    // clamps it there, which is exactly what turns a rectangle into a
    // stadium shape instead of just a rounded-corner box.
    borderRadius: radius.pill,
    backgroundColor: SCRIM,
  },
  text: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
    fontFamily,
    flexShrink: 1,
  },
  close: {
    marginLeft: 4,
  },
  caret: {
    position: 'absolute',
    width: CARET,
    height: CARET,
    backgroundColor: SCRIM,
    transform: [{ rotate: '45deg' }],
  },
});

export default TagBubble;
