/**
 * Catches any URL that doesn't resolve to a real route -- most plausibly a
 * push notification whose `url` names a screen this build no longer has
 * (the payload is written by the notify Edge Function and can outlive a
 * rename). Expo Router's stock unmatched-route screen is unstyled and
 * offers no way back, which is a bad place to strand someone who did
 * nothing but tap a notification.
 */

import { Stack, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { EmptyState } from '../components/EmptyState';
import { useTheme } from '../lib/theme';

export default function NotFound() {
  const router = useRouter();
  const { colors } = useTheme();

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: '' }} />
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <EmptyState
          icon="compass"
          title="This page doesn't exist"
          body="The link you followed may be broken, or the post may have been deleted."
          actionLabel="Go home"
          onAction={() => router.replace('/(tabs)')}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center' },
});
