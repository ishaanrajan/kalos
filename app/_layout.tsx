import { useEffect } from 'react';
import { ActivityIndicator, Alert, AppState, View } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as Notifications from 'expo-notifications';
import * as Updates from 'expo-updates';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

// React Query's focus manager has no idea what "foreground" until it's told
// -- without this, refetchOnWindowFocus is silently a no-op on iOS/Android,
// unlike on web where it's automatic.
function onAppStateChange(status: AppStateStatus) {
  focusManager.setFocused(status === 'active');
  if (status === 'active') {
    void checkForUpdateOnForeground();
  }
}

// expo-updates' default "check on load" only fires once per cold JS start --
// backgrounding and reopening from the app switcher (as opposed to a real
// force-quit) never re-triggers it, so someone who never fully force-quits
// can be stuck running a stale bundle indefinitely. This is what actually
// caused several people to hit the same already-fixed HEIC posting bug days
// after the fix shipped -- they were still running the old bundle and had
// no way to know it. Checking (and offering to apply) on every foreground
// closes that gap instead of relying on users to know the difference between
// backgrounding and force-quitting.
let checkingForUpdate = false;
async function checkForUpdateOnForeground(): Promise<void> {
  if (__DEV__ || checkingForUpdate) return;
  checkingForUpdate = true;
  try {
    const result = await Updates.checkForUpdateAsync();
    if (!result.isAvailable) return;
    await Updates.fetchUpdateAsync();
    Alert.alert('Update available', 'A new version of Kalos is ready.', [
      { text: 'Later', style: 'cancel' },
      { text: 'Restart now', onPress: () => Updates.reloadAsync() },
    ]);
  } catch {
    // Best-effort -- a failed check should never block using the app.
  } finally {
    checkingForUpdate = false;
  }
}

function RootNavigator() {
  const { session, profile, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const { colors } = useTheme();

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === '(auth)';

    if (!session && !inAuthGroup) {
      router.replace('/(auth)/sign-in');
      return;
    }
    if (session && inAuthGroup) {
      router.replace('/(tabs)');
      return;
    }

    // Forced onboarding for a brand-new account (0010_onboarding.sql) --
    // never true for an existing account, since onboarded defaults to true
    // for every row that isn't freshly created by handle_new_user().
    // Checked as `=== false`, not `!profile.onboarded`: if the migration
    // hasn't run yet, the column is simply absent from the row and reads as
    // undefined, which must NOT be treated the same as false here.
    if (session && profile && profile.onboarded === false) {
      if (!profile.avatar_path) {
        if (segments[0] !== 'onboarding-avatar') router.replace('/onboarding-avatar');
        return;
      }
      if (profile.post_count === 0) {
        const onNewPost = segments[0] === '(tabs)' && segments[1] === 'new';
        if (!onNewPost) router.replace('/(tabs)/new');
        return;
      }
    }
  }, [session, profile, loading, segments, router]);

  // The notify Edge Function attaches { url } to every push it sends;
  // tapping one just needs to hand that straight to the router. Dismissing
  // it and clearing the badge afterward is separate from that navigation --
  // tapping a delivered notification doesn't reliably clear it from the
  // tray/Notification Center on its own, so it's done explicitly here.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const url = response.notification.request.content.data?.url;
      if (typeof url === 'string') router.push(url as never);
      Notifications.dismissNotificationAsync(response.notification.request.identifier).catch(() => undefined);
      Notifications.setBadgeCountAsync(0).catch(() => undefined);
    });
    return () => sub.remove();
  }, [router]);

  // A push arriving while the app is already open is the one case AppState
  // focus can't catch on its own -- nothing "returns to foreground" if you
  // never left. Refresh the badge-driving queries directly when that happens.
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(() => {
      queryClient.invalidateQueries({ queryKey: ['dm-unread'] });
      queryClient.invalidateQueries({ queryKey: ['dm-inbox'] });
      queryClient.invalidateQueries({ queryKey: ['dm-my-threads'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', onAppStateChange);
    return () => sub.remove();
  }, []);

  // Covers a fresh cold launch too, not just later foreground transitions --
  // the default "check on load" behavior downloads a pending update
  // silently in the background but doesn't apply or announce it until the
  // launch *after* that one, which is exactly the gap that let people keep
  // hitting an already-fixed bug for days.
  useEffect(() => {
    void checkForUpdateOnForeground();
  }, []);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        headerBackButtonDisplayMode: 'minimal',
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        headerTitleStyle: { color: colors.text },
      }}
    >
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="onboarding-avatar" />
      <Stack.Screen name="post/[id]" options={{ headerShown: true, title: 'Post' }} />
      <Stack.Screen name="profile/[username]" options={{ headerShown: true, title: '' }} />
      <Stack.Screen name="follows/[username]" options={{ headerShown: true, title: '' }} />
      <Stack.Screen name="likes/[postId]" options={{ headerShown: true, title: 'Likes' }} />
      <Stack.Screen name="edit-profile" options={{ headerShown: true, title: 'Edit profile' }} />
      <Stack.Screen name="edit-caption/[id]" options={{ headerShown: true, title: 'Edit caption' }} />
      <Stack.Screen name="search" options={{ headerShown: true, title: 'Search' }} />
      <Stack.Screen name="dm/index" options={{ headerShown: true, title: 'Messages' }} />
      <Stack.Screen name="dm/[username]" options={{ headerShown: true, title: '' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <StatusBar style="auto" />
            <RootNavigator />
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
