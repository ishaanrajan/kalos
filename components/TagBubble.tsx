/**
 * The username label that sits on a photo where someone was tagged: a dark
 * pill with a small caret pointing at the spot. Used in view mode on
 * PostCard (press opens the profile) and in edit mode in the composer's
 * tag editor (press removes the tag; an "x" makes that legible).
 *
 * The anchor is a fraction of the frame (see PostTag in lib/types.ts). The
 * pill's own size isn't known until it lays out, so it renders invisible for
 * one frame, measures, then positions itself: centered under the point,
 * flipped above it when there's no room below, and slid sideways so it
 * never leaves the photo. The caret stays on the point either way.
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { fontFamily } from '../lib/theme';

export interface TagBubbleProps {
  username: string;
  /** Fraction of the frame, 0..1. */
  x: number;
  y: number;
  /** Size of the photo the bubble sits on, in points. */
  frame: { width: number; height: number };
  /** View mode -- typically opens the profile. */
  onPress?: () => void;
  /** Edit mode -- shows an "x" and turns the press into a removal. */
  onRemove?: () => void;
}

const INSET = 4;
const CARET = 8;
/** Gap between the anchor point and the pill, caret included. */
const GAP = 6;

export function TagBubble({ username, x, y, frame, onPress, onRemove }: TagBubbleProps) {
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
  const below = ay + GAP + pillH <= frame.height - INSET;
  const top = below ? ay + GAP : ay - GAP - pillH;
  const left = clamp(ax - pillW / 2, INSET, Math.max(INSET, frame.width - pillW - INSET));
  // The caret tracks the anchor, not the pill, but stays inside the pill's
  // rounded corners so it never floats detached.
  const caretLeft = clamp(ax - CARET / 2, left + INSET, left + pillW - CARET - INSET);
  const caretTop = below ? top - CARET / 2 : top + pillH - CARET / 2;

  const handlePress = onRemove ?? onPress;

  return (
    <>
      <View
        pointerEvents="none"
        style={[
          styles.caret,
          { left: caretLeft, top: caretTop, opacity: size ? 1 : 0 },
        ]}
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
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 4,
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
