/**
 * Retrogram design tokens.
 *
 * The palette and type scale target Instagram circa 2015–2016: near-white
 * chrome, thin hairline dividers, Helvetica-ish type, and exactly two accent
 * colours (the classic blue and the heart red). Dark mode is a modern
 * addition — it keeps the same structure and only swaps surfaces.
 *
 * This module is pure tokens plus a `useTheme()` hook. It imports nothing from
 * the app, so components and screens can both depend on it freely.
 */

import { Platform, StyleSheet, useColorScheme } from 'react-native';
import type { TextStyle, ViewStyle } from 'react-native';

// ---------------------------------------------------------------------------
// Raw palette
// ---------------------------------------------------------------------------

/**
 * The literal colour values. Prefer `useTheme().colors` in components — these
 * are exported for the rare case where a scheme-independent value is needed
 * (e.g. the white heart burst that always sits on top of a photo).
 */
export const palette = {
  white: '#ffffff',
  offWhite: '#fafafa',
  /** Primary text. */
  ink: '#262626',
  /** Secondary text, timestamps, placeholder glyphs. */
  grey: '#8e8e8e',
  /** Hairline dividers and outline-button borders. */
  divider: '#dbdbdb',
  /** Inert fill: image placeholders, secondary buttons. */
  fill: '#efefef',
  /** The classic Instagram blue. */
  blue: '#3897f0',
  bluePressed: '#2d7dc9',
  /** Heart red. */
  red: '#ed4956',
  black: '#000000',
  darkFill: '#1a1a1a',
  darkPlaceholder: '#1c1c1c',
  darkDivider: '#262626',
  darkInk: '#fafafa',
} as const;

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

export interface ThemeColors {
  /** Screen background — very slightly off-white in the 2015 style. */
  background: string;
  /** Card / row background. */
  surface: string;
  /** Inert fill for secondary buttons and pressed states. */
  surfaceAlt: string;
  /** Shown underneath a photo while it loads. */
  imagePlaceholder: string;
  text: string;
  textSecondary: string;
  /** Text that sits on top of `accent` or a photo. */
  textInverse: string;
  border: string;
  accent: string;
  accentPressed: string;
  /** Liked-heart red. */
  heart: string;
  /** Translucent black for overlays. */
  scrim: string;
}

export const lightColors: ThemeColors = {
  background: palette.offWhite,
  surface: palette.white,
  surfaceAlt: palette.fill,
  imagePlaceholder: palette.fill,
  text: palette.ink,
  textSecondary: palette.grey,
  textInverse: palette.white,
  border: palette.divider,
  accent: palette.blue,
  accentPressed: palette.bluePressed,
  heart: palette.red,
  scrim: 'rgba(0, 0, 0, 0.45)',
};

export const darkColors: ThemeColors = {
  background: palette.black,
  surface: palette.black,
  surfaceAlt: palette.darkFill,
  imagePlaceholder: palette.darkPlaceholder,
  text: palette.darkInk,
  textSecondary: palette.grey,
  textInverse: palette.black,
  border: palette.darkDivider,
  accent: palette.blue,
  accentPressed: palette.bluePressed,
  heart: palette.red,
  scrim: 'rgba(0, 0, 0, 0.6)',
};

// ---------------------------------------------------------------------------
// Spacing / radii
// ---------------------------------------------------------------------------

/** 4pt scale. `md` (12) is the standard horizontal gutter for post chrome. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export type Spacing = typeof spacing;

export const radius = {
  /** Buttons and chips — 2015 corners were barely rounded. */
  sm: 3,
  md: 6,
  lg: 12,
  pill: 999,
} as const;

export type Radius = typeof radius;

// ---------------------------------------------------------------------------
// Type scale
// ---------------------------------------------------------------------------

/**
 * iOS gets Helvetica Neue (what the era actually shipped). Android is left to
 * the system face, because pinning `sans-serif` there breaks synthetic weights
 * like `600`. Web gets an explicit Helvetica stack.
 */
export const fontFamily: string | undefined = Platform.select({
  ios: 'Helvetica Neue',
  web: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  default: undefined,
});

/**
 * For the "Kalos" wordmark only -- everywhere else in the UI is correctly
 * Helvetica Neue, which is exactly why a thin-weight cut of that same face
 * reads wrong for the one piece of hand-lettered logotype a 2015 user would
 * have actually seen.
 *
 * 'cursive' is one of Android's generic font family names (alongside
 * 'sans-serif'/'serif'/'monospace') -- it resolves to whatever script face
 * the device ships, same idea as iOS's named system font below, just an
 * alias instead of a specific face. An earlier version of this left Android
 * out of the Platform.select entirely, which silently fell through to
 * `default: fontFamily` -- the wordmark rendered in plain Helvetica Neue on
 * Android with no error to notice it by.
 */
export const wordmarkFontFamily: string | undefined = Platform.select({
  ios: 'Snell Roundhand',
  android: 'cursive',
  web: '"Segoe Script", "Bradley Hand", cursive',
  default: fontFamily,
});

export interface TypeScale {
  /** Thin, large — empty states and "You're all caught up". */
  display: TextStyle;
  /** Section and screen headings. */
  title: TextStyle;
  /** Usernames in post headers and comment rows. */
  username: TextStyle;
  /** Captions and comment bodies. */
  body: TextStyle;
  /** Body weight-matched bold, for inline username prefixes and like counts. */
  bodyStrong: TextStyle;
  /** Slightly smaller supporting copy. */
  caption: TextStyle;
  /** Secondary UI text — "View all 12 comments". */
  meta: TextStyle;
  metaStrong: TextStyle;
  /** The 2015 post timestamp: tiny, letterspaced, uppercase. */
  timestamp: TextStyle;
  button: TextStyle;
}

export const typography: TypeScale = {
  display: { fontFamily, fontSize: 22, fontWeight: '300', letterSpacing: 0.2 },
  title: { fontFamily, fontSize: 16, fontWeight: '600' },
  username: { fontFamily, fontSize: 14, fontWeight: '600', letterSpacing: 0.1 },
  body: { fontFamily, fontSize: 14, fontWeight: '400', lineHeight: 18 },
  bodyStrong: { fontFamily, fontSize: 14, fontWeight: '600', lineHeight: 18 },
  caption: { fontFamily, fontSize: 13, fontWeight: '400', lineHeight: 17 },
  meta: { fontFamily, fontSize: 13, fontWeight: '400' },
  metaStrong: { fontFamily, fontSize: 13, fontWeight: '600' },
  timestamp: {
    fontFamily,
    fontSize: 10,
    fontWeight: '400',
    letterSpacing: 0.35,
    textTransform: 'uppercase',
  },
  button: { fontFamily, fontSize: 14, fontWeight: '600' },
};

// ---------------------------------------------------------------------------
// Hairlines
// ---------------------------------------------------------------------------

/** One physical pixel — the divider weight the 2015 UI used everywhere. */
export const hairlineWidth = StyleSheet.hairlineWidth;

/**
 * The native stack header's own content height -- iOS's nav bar is a fixed
 * 44pt; Android's Material app bar is 56dp. `insets.top` alone only covers
 * the status bar/notch, not the header content sitting below it, so a
 * KeyboardAvoidingView on a screen with a header needs `insets.top + this`
 * as its offset, not just `insets.top`. Using the iOS value on Android (or
 * vice versa) either leaves a gap or the composer overlaps the header.
 */
export const nativeHeaderHeight = Platform.select({ ios: 44, default: 56 });

export type HairlineSide = 'top' | 'bottom' | 'left' | 'right' | 'all';

/**
 * Build a one-pixel border style.
 *
 * @example
 * <View style={[styles.header, hairline(colors.border, 'bottom')]} />
 */
export function hairline(color: string, side: HairlineSide = 'bottom'): ViewStyle {
  switch (side) {
    case 'top':
      return { borderTopWidth: hairlineWidth, borderTopColor: color };
    case 'bottom':
      return { borderBottomWidth: hairlineWidth, borderBottomColor: color };
    case 'left':
      return { borderLeftWidth: hairlineWidth, borderLeftColor: color };
    case 'right':
      return { borderRightWidth: hairlineWidth, borderRightColor: color };
    case 'all':
      return { borderWidth: hairlineWidth, borderColor: color };
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export type ColorSchemeName = 'light' | 'dark';

export interface Theme {
  scheme: ColorSchemeName;
  colors: ThemeColors;
  spacing: Spacing;
  radius: Radius;
  typography: TypeScale;
  hairlineWidth: number;
  fontFamily: string | undefined;
  wordmarkFontFamily: string | undefined;
}

export const lightTheme: Theme = {
  scheme: 'light',
  colors: lightColors,
  spacing,
  radius,
  typography,
  hairlineWidth,
  fontFamily,
  wordmarkFontFamily,
};

export const darkTheme: Theme = {
  scheme: 'dark',
  colors: darkColors,
  spacing,
  radius,
  typography,
  hairlineWidth,
  fontFamily,
  wordmarkFontFamily,
};

/**
 * Resolve the active theme from the OS colour scheme.
 *
 * Every screen under app/ was audited to pull its colors from here instead
 * of hardcoding light-mode literals (`#fff`, `#262626`, ...) -- that
 * mismatch, not a flaw in the palette itself, was the entire cause of the
 * bug this once shipped as a stopgap for: components and screens
 * disagreeing with each other on a phone in Dark Mode, producing
 * white-on-white "Edit profile"/"Log out" buttons above a black grid.
 *
 * A few spots stay intentionally hardcoded rather than theme-driven, and
 * should stay that way: content sitting on top of a photo (the heart burst,
 * the Explore "reason" chip) or on the fixed-blue accent color (button
 * labels/icons on a primary button) -- neither one is meant to follow the
 * screen's own light/dark state.
 *
 * Returns one of two module-level constants, so the reference is stable
 * across renders and safe to use in `useMemo`/`useCallback` dependency
 * arrays.
 */
export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkTheme : lightTheme;
}
