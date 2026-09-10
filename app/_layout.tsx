import { useEffect, useRef } from 'react';
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import type { ErrorBoundaryProps } from 'expo-router';
import * as Notifications from 'expo-notifications';
import NetInfo from '@react-native-community/netinfo';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { EmptyState } from '../components/EmptyState';
import { OfflineBanner } from '../components/OfflineBanner';
import { checkForUpdateOnForeground } from '../lib/updates';

/**
 * The only routes a push is ever allowed to open. `url` arrives from the
 * notify Edge Function, i.e. from the server, and used to be handed to
 * router.push() behind an `as never` cast that defeated the typed-routes
 * checking app.json turns on -- a renamed route or a malformed payload put
 * the user on Expo Router's stock "Unmatched Route" screen. These three
 * shapes are exactly what notify emits (`/dm/:username`, `/post/:id`,
 * `/profile/:username`); anything else is dropped on the floor.
 */
const PUSH_ROUTE_RE = /^\/(?:dm|post|profile)\/[A-Za-z0-9._-]{1,64}$/;

function toPushRoute(url: unknown): string | null {
  return typeof url === 'string' && PUSH_ROUTE_RE.test(url) ? url : null;
}

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

// React Native has no navigator.onLine, so react-query's onlineManager
// assumes "always online" unless it's explicitly bridged. Without this,
// mutations never enter the paused state (they fail on the first attempt
// instead of resuming when signal returns), refetchOnReconnect never fires,
// and queries burn their single retry immediately and land in isError. Set
// up once at module scope, before any query can run.
// Hold the native splash until auth has actually resolved. Expo Router would
// otherwise hide it the moment the navigator is ready, which is well before
// we know whether to show the feed or sign-in -- so a cold launch went
// splash -> bootstrap spinner -> content, and in dark mode the spinner's
// screen was a white flash between two dark ones.
void SplashScreen.preventAutoHideAsync();

onlineManager.setEventListener((setOnline) =>
  NetInfo.addEventListener((state) => {
    // isConnected only -- not isInternetReachable. That field is an active
    // probe (a reachability request to a fixed host), not a passive read of
    // the OS's own network state, and it's known to false-negative on
    // ordinary wifi/cellular, VPNs, and anything reachability-adjacent that
    // blocks or is slow to answer that one probe while every real request
    // (Supabase included) goes through fine. Gating the banner on it was
    // showing "No connection" on a perfectly working connection.
    setOnline(state.isConnected !== false);
  })
);

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

  // The notify Edge Function attaches { url } to every push it sends, and
  // tapping one navigates there. This deliberately does NOT use
  // addNotificationResponseReceivedListener: on a cold start the OS queues
  // the tap and replays it the instant the JS module attaches (iOS
  // NotificationCenterManager.pendingResponses, Android
  // NotificationsEmitter.lastNotificationResponseBundle), which is long
  // before auth has resolved -- and this component renders no navigator
  // until it has. Pushing then threw "Attempted to navigate before mounting
  // the Root Layout component" out of expo-router's assertIsReady, with no
  // error boundary to catch it, so tapping a DM notification on a
  // force-quit app was a hard crash. useLastNotificationResponse holds the
  // response instead of firing it at us, so we can navigate on our own
  // terms: once loading is false there is always a <Stack> mounted below.
  const lastResponse = Notifications.useLastNotificationResponse();
  const handledNotificationRef = useRef<string | null>(null);

  useEffect(() => {
    // Wait for the navigator, and for the guard above to have settled --
    // deep-linking a signed-out user into /dm/... only to replace it with
    // sign-in a tick later is worse than not deep-linking at all.
    if (loading || !session || !lastResponse) return;

    const id = lastResponse.notification.request.identifier;
    if (handledNotificationRef.current === id) return;
    handledNotificationRef.current = id;

    const target = toPushRoute(lastResponse.notification.request.content.data?.url);
    if (target) router.push(target as never);

    // Tapping a delivered notification doesn't reliably clear it from the
    // tray/Notification Center on its own, so it's done explicitly.
    Notifications.dismissNotificationAsync(id).catch(() => undefined);
    Notifications.setBadgeCountAsync(0).catch(() => undefined);
  }, [lastResponse, loading, session, router]);

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

  // Hand off from the native splash only once there's real content behind
  // it, so the user never sees the bootstrap gate at all on a normal launch.
  useEffect(() => {
    if (!loading) void SplashScreen.hideAsync();
  }, [loading]);

  // The bootstrap spinner is an overlay, not an early return. Returning it
  // instead of the <Stack> meant that during auth bootstrap there was no
  // navigator mounted at all, so anything that navigated in that window --
  // a tapped push notification, most of all -- threw out of expo-router's
  // assertIsReady and took the app down. Keeping <Stack> rendered from the
  // very first frame makes navigationRef.isReady() true throughout.
  return (
    <>
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

      {loading ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            styles.gate,
            // Without an explicit background this inherited the platform
            // default (white), so a dark-mode cold launch flashed a white
            // rectangle before the app's own near-black UI appeared.
            { backgroundColor: colors.background },
          ]}
        >
          <ActivityIndicator />
        </View>
      ) : null}

      <OfflineBanner />
    </>
  );
}

const styles = StyleSheet.create({
  gate: { alignItems: 'center', justifyContent: 'center' },
  errorRoot: { flex: 1, justifyContent: 'center' },
});

/**
 * Expo Router renders this in place of any route that throws while
 * rendering. Without it a single bad row from Supabase -- a null author, a
 * caption that trips the mention parser -- was an unrecoverable white
 * screen in a production build, force quit the only way out.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.errorRoot, { backgroundColor: colors.background }]}>
      <EmptyState
        icon="alert-triangle"
        title="Something went wrong"
        body={error.message}
        actionLabel="Try again"
        onAction={() => void retry()}
      />
    </View>
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
