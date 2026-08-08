/**
 * Circular avatar with an initials fallback.
 *
 * Presentational only: it takes a fully-resolved `imageUrl`, never a storage
 * path.
 */

import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Image } from 'expo-image';

import { useTheme } from '../lib/theme';

export interface AvatarProps {
  /** Fully-resolved public URL. Falls back to initials when null/undefined. */
  url?: string | null;
  /** Alias for `url`. `url` wins when both are given. */
  imageUrl?: string | null;
  /** Used for the initials fallback and the accessibility label. */
  username: string;
  /** Diameter in points. Defaults to 32 (the post-header size). */
  size?: number;
  /** Draws a hairline ring around the avatar. */
  ring?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** "maya.codes" -> "M", "maya codes" -> "MC". */
function initialsFor(username: string): string {
  const parts = username.trim().split(/[\s._-]+/u).filter(Boolean);
  if (parts.length === 0) {
    return '?';
  }
  if (parts.length === 1) {
    return parts[0]!.charAt(0).toUpperCase();
  }
  return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
}

export function Avatar({
  url,
  imageUrl,
  username,
  size = 32,
  ring = false,
  onPress,
  style,
  testID,
}: AvatarProps) {
  const { colors, fontFamily, hairlineWidth } = useTheme();
  const initials = useMemo(() => initialsFor(username), [username]);
  const source = url ?? imageUrl ?? null;

  const shape: ViewStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: colors.surfaceAlt,
    ...(ring ? { borderWidth: hairlineWidth, borderColor: colors.border } : null),
  };

  const content = source ? (
    <Image
      source={source}
      style={styles.image}
      contentFit="cover"
      transition={150}
      cachePolicy="memory-disk"
      recyclingKey={source}
      accessible={false}
    />
  ) : (
    <Text
      style={[
        styles.initials,
        {
          fontFamily,
          color: colors.textSecondary,
          // Keep the glyph proportional at every size.
          fontSize: Math.max(9, Math.round(size * 0.38)),
        },
      ]}
      numberOfLines={1}
      allowFontScaling={false}
    >
      {initials}
    </Text>
  );

  if (!onPress) {
    return (
      <View
        style={[styles.root, shape, style]}
        testID={testID}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${username}'s profile photo`}
      >
        {content}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${username}'s profile photo`}
      style={({ pressed }) => [styles.root, shape, pressed && styles.pressed, style]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.7,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  initials: {
    fontWeight: '600',
    includeFontPadding: false,
    textAlign: 'center',
  },
});

export default Avatar;
