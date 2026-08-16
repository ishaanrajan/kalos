/**
 * The end of the feed. Not a teaser, not a "suggested for you" rail — just a
 * check and a sentence telling you there is nothing more to look at.
 *
 * Render this as the feed's `ListFooterComponent` once the last page came back
 * short.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { hairlineWidth, spacing, useTheme } from '../lib/theme';

export interface EndOfFeedProps {
  title?: string;
  /** The line of secondary text under the title. */
  body?: string;
  /** Draws a hairline above the block, to separate it from the last post. */
  showDivider?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const CIRCLE = 56;

export function EndOfFeed({
  title = "You're all caught up",
  body = "You've seen all new posts from the past week.",
  showDivider = true,
  style,
  testID,
}: EndOfFeedProps) {
  const { colors, typography } = useTheme();

  return (
    <View
      style={[
        styles.root,
        showDivider && { borderTopWidth: hairlineWidth, borderTopColor: colors.border },
        style,
      ]}
      testID={testID}
      accessible
      accessibilityRole="summary"
      accessibilityLabel={body ? `${title}. ${body}` : title}
    >
      <View style={[styles.circle, { borderWidth: hairlineWidth * 2, borderColor: colors.accent }]}>
        <Feather name="check" size={26} color={colors.accent} />
      </View>

      <Text style={[typography.display, styles.title, { color: colors.text }]}>{title}</Text>

      {/* Callers can pass "" to get just the title and the check mark. */}
      {body ? (
        <Text style={[typography.body, styles.body, { color: colors.textSecondary }]}>{body}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl + spacing.sm,
    paddingBottom: spacing.xxl + spacing.xl,
  },
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    textAlign: 'center',
  },
  body: {
    textAlign: 'center',
    marginTop: spacing.sm,
    maxWidth: 280,
  },
});

export default EndOfFeed;
