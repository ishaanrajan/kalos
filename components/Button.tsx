/**
 * The three buttons the 2015 UI actually had: a solid blue primary ("Follow",
 * "Sign up"), a grey secondary, and a hairline outline ("Following", "Edit
 * profile").
 */

import React, { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { hairlineWidth, spacing, radius, useTheme } from '../lib/theme';
import type { ThemeColors } from '../lib/theme';

export type ButtonVariant = 'primary' | 'secondary' | 'outline';
export type ButtonSize = 'small' | 'medium' | 'large';

/** Any glyph name from the Feather set. */
export type FeatherIconName = React.ComponentProps<typeof Feather>['name'];

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Optional Feather glyph rendered before the label. */
  icon?: FeatherIconName;
  disabled?: boolean;
  /** Swaps the label for a spinner and blocks presses. */
  loading?: boolean;
  /** Stretches to the width of the parent. */
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
  testID?: string;
}

interface SizeSpec {
  height: number;
  paddingHorizontal: number;
  fontSize: number;
  iconSize: number;
}

const SIZES: Record<ButtonSize, SizeSpec> = {
  small: { height: 30, paddingHorizontal: spacing.md, fontSize: 13, iconSize: 14 },
  medium: { height: 38, paddingHorizontal: spacing.lg, fontSize: 14, iconSize: 16 },
  large: { height: 46, paddingHorizontal: spacing.xl, fontSize: 15, iconSize: 18 },
};

interface VariantSpec {
  background: string;
  backgroundPressed: string;
  foreground: string;
  border: string | null;
}

function variantSpec(variant: ButtonVariant, colors: ThemeColors): VariantSpec {
  switch (variant) {
    case 'primary':
      return {
        background: colors.accent,
        backgroundPressed: colors.accentPressed,
        foreground: '#ffffff',
        border: null,
      };
    case 'secondary':
      return {
        background: colors.surfaceAlt,
        backgroundPressed: colors.border,
        foreground: colors.text,
        border: null,
      };
    case 'outline':
      return {
        background: 'transparent',
        backgroundPressed: colors.surfaceAlt,
        foreground: colors.text,
        border: colors.border,
      };
  }
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'medium',
  icon,
  disabled = false,
  loading = false,
  fullWidth = false,
  style,
  labelStyle,
  testID,
}: ButtonProps) {
  const { colors, typography } = useTheme();
  const spec = useMemo(() => variantSpec(variant, colors), [variant, colors]);
  const dims = SIZES[size];
  const inactive = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      style={({ pressed }) => [
        styles.root,
        {
          height: dims.height,
          paddingHorizontal: dims.paddingHorizontal,
          borderRadius: radius.sm,
          backgroundColor: pressed && !inactive ? spec.backgroundPressed : spec.background,
        },
        spec.border !== null && { borderWidth: hairlineWidth, borderColor: spec.border },
        fullWidth && styles.fullWidth,
        disabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={spec.foreground} />
      ) : (
        <View style={styles.content}>
          {icon ? (
            <Feather
              name={icon}
              size={dims.iconSize}
              color={spec.foreground}
              style={styles.icon}
            />
          ) : null}
          <Text
            style={[
              typography.button,
              { fontSize: dims.fontSize, color: spec.foreground },
              labelStyle,
            ]}
            numberOfLines={1}
          >
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
  disabled: {
    opacity: 0.4,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    marginRight: spacing.xs + 2,
  },
});

export default Button;
