/**
 * The heart. Outline when unliked, solid red when liked, with a quick
 * squash-then-spring on every like.
 *
 * The animation is optimistic: it fires on press, before the parent has flipped
 * the `liked` prop (and before any network round-trip). It also fires when
 * `liked` flips to true from the outside — which is how a double-tap on the
 * photo makes the header heart pop too.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../lib/theme';

export interface LikeButtonProps {
  /** Current like state. The icon always reflects this. */
  liked: boolean;
  /** Called on tap. The parent owns the toggle. */
  onPress: () => void;
  /** Glyph size in points. Defaults to 26. */
  size?: number;
  /** Overrides the unliked icon colour. Defaults to the theme's text colour. */
  color?: string;
  /** Overrides the liked icon colour. Defaults to the theme's heart red. */
  likedColor?: string;
  /** Fire an impact haptic when liking. Defaults to true. */
  haptics?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const SQUASH = { duration: 90, easing: Easing.out(Easing.quad) };
const SPRING = { damping: 6, stiffness: 320, mass: 0.5 };

export function LikeButton({
  liked,
  onPress,
  size = 26,
  color,
  likedColor,
  haptics = true,
  disabled = false,
  style,
  testID,
}: LikeButtonProps) {
  const { colors } = useTheme();
  const scale = useSharedValue(1);

  // Tracks the previous `liked` so we only animate on false -> true, and lets a
  // self-initiated press suppress the duplicate animation the prop flip causes.
  const prevLiked = useRef(liked);
  const pressInitiated = useRef(false);

  const pulse = useCallback(() => {
    scale.value = withSequence(withTiming(0.82, SQUASH), withSpring(1, SPRING));
  }, [scale]);

  useEffect(() => {
    const wasLiked = prevLiked.current;
    prevLiked.current = liked;
    if (liked && !wasLiked && !pressInitiated.current) {
      pulse();
    }
    pressInitiated.current = false;
  }, [liked, pulse]);

  const handlePress = useCallback(() => {
    if (!liked) {
      pressInitiated.current = true;
      if (haptics) {
        // Fire-and-forget: unsupported on web and in iOS Low Power Mode.
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      }
    }
    pulse();
    onPress();
  }, [liked, haptics, pulse, onPress]);

  const animatedStyle = useAnimatedStyle(() => {
    'worklet';
    return { transform: [{ scale: scale.value }] };
  });

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      testID={testID}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={liked ? 'Unlike' : 'Like'}
      accessibilityState={{ selected: liked, disabled }}
      style={({ pressed }) => [styles.root, pressed && styles.pressed, style]}
    >
      <Animated.View style={animatedStyle}>
        <Ionicons
          name={liked ? 'heart' : 'heart-outline'}
          // The outline glyph's stroke reads heavier than a hairline at equal
          // size, which flattens the outline -> filled "pop" -- sizing it down
          // a touch restores that contrast without touching the filled state.
          size={liked ? size : size - 2}
          color={liked ? (likedColor ?? colors.heart) : (color ?? colors.text)}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
});

export default LikeButton;
