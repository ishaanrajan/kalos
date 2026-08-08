/**
 * Centred empty state: thin-line icon, title, supporting copy, optional action.
 * Used for empty profiles, an empty Activity tab, a search with no results.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { hairlineWidth, spacing, useTheme } from '../lib/theme';
import { Button } from './Button';
import type { FeatherIconName } from './Button';

export interface EmptyStateProps {
  /** Feather glyph shown in a thin circle above the title. */
  icon?: FeatherIconName;
  title: string;
  /** One or two lines of secondary copy. */
  body?: string;
  /** Renders a primary button when both this and `onAction` are set. */
  actionLabel?: string;
  onAction?: () => void;
  /** Alias for `onAction`. */
  onPressAction?: () => void;
  /** Diameter of the icon circle. Defaults to 64. */
  iconSize?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function EmptyState({
  icon,
  title,
  body,
  actionLabel,
  onAction,
  onPressAction,
  iconSize = 64,
  style,
  testID,
}: EmptyStateProps) {
  const { colors, typography } = useTheme();
  const action = onAction ?? onPressAction;

  return (
    <View style={[styles.root, style]} testID={testID}>
      {icon ? (
        <View
          style={[
            styles.iconCircle,
            {
              width: iconSize,
              height: iconSize,
              borderRadius: iconSize / 2,
              borderWidth: hairlineWidth * 2,
              borderColor: colors.text,
            },
          ]}
        >
          <Feather name={icon} size={Math.round(iconSize * 0.42)} color={colors.text} />
        </View>
      ) : null}

      <Text style={[typography.display, styles.title, { color: colors.text }]}>{title}</Text>

      {body ? (
        <Text style={[typography.body, styles.body, { color: colors.textSecondary }]}>
          {body}
        </Text>
      ) : null}

      {actionLabel && action ? (
        <Button
          label={actionLabel}
          onPress={action}
          variant="primary"
          size="medium"
          style={styles.action}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
  },
  iconCircle: {
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
    maxWidth: 300,
  },
  action: {
    marginTop: spacing.xl,
  },
});

export default EmptyState;
