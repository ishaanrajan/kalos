/**
 * A thin "No connection" strip pinned under the status bar whenever the
 * device is offline.
 *
 * Before this the app had no offline signal at all: a failed query surfaced
 * as a spinner that never resolved, or -- worse -- as a confident empty
 * state ("No likes yet", "Post not found"), so a tunnel looked like data
 * loss. This tells the user which of the two it is, once, globally, instead
 * of every screen having to guess.
 *
 * Driven by react-query's own onlineManager rather than a second NetInfo
 * subscription, so the banner and the query layer can never disagree about
 * whether we're online.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { onlineManager } from '@tanstack/react-query';

import { useTheme } from '../lib/theme';

export function OfflineBanner() {
  const [online, setOnline] = useState(() => onlineManager.isOnline());
  const insets = useSafeAreaInsets();
  const { colors, typography } = useTheme();

  useEffect(() => onlineManager.subscribe(setOnline), []);

  if (online) return null;

  return (
    <View
      // Sits above the navigator rather than inside any one screen, so it
      // survives navigation and doesn't shift a screen's own layout.
      style={[
        styles.root,
        { paddingTop: insets.top + 6, backgroundColor: colors.textSecondary },
      ]}
      accessibilityRole="alert"
    >
      <Text style={[typography.meta, styles.label]} maxFontSizeMultiplier={1.4}>
        No connection
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingBottom: 6,
    alignItems: 'center',
  },
  label: { color: '#ffffff', fontWeight: '600' },
});
