import { useEffect } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '../lib/auth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

// React Query's focus manager has no idea what "foreground" means on native
// until it's told -- without this, refetchOnWindowFocus is silently a no-op
// on iOS/Android, unlike on web where it's automatic.
function onAppStateChange(status: AppStateStatus) {
  focusManager.setFocused(status === 'active');
}

function RootNavigator() {
  const { session, profile, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

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
  // tapping one just needs to hand that straight to the router.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const url = response.notification.request.content.data?.url;
      if (typeof url === 'string') router.push(url as never);
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
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', onAppStateChange);
    return () => sub.remove();
  }, []);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="onboarding-avatar" />
      <Stack.Screen name="post/[id]" options={{ headerShown: true, title: 'Post' }} />
      <Stack.Screen name="profile/[username]" options={{ headerShown: true, title: '' }} />
      <Stack.Screen name="follows/[username]" options={{ headerShown: true, title: '' }} />
      <Stack.Screen name="likes/[postId]" options={{ headerShown: true, title: 'Likes' }} />
      <Stack.Screen name="edit-profile" options={{ headerShown: true, title: 'Edit profile' }} />
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
            {/* Content is always light (lib/theme.ts) -- "auto" would pick
                light status bar icons on a phone in Dark Mode, invisible
                against our white background. */}
            <StatusBar style="dark" />
            <RootNavigator />
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
