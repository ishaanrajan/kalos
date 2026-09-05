import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';

// Foreground notifications are hidden by default; this makes them behave
// like every other app -- banner + sound while Kalos is open too.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/**
 * Android 8+ (API 26+) drops every notification into a "Miscellaneous"
 * fallback channel at default importance unless the app creates its own --
 * unlike iOS, where a granted permission is enough to get a heads-up banner.
 * Skipped with no error, that fallback is exactly the wordmark bug's shape:
 * push "works" (the notification lands in the shade) but silently degrades
 * -- no heads-up pop-over, no guaranteed sound -- with nothing to notice it
 * by. iOS ignores this call entirely (the module below is Android-only), so
 * it's a no-op there rather than a second code path to keep in sync.
 */
async function ensureAndroidNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Default',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    sound: 'default',
  });
}

/**
 * Requests permission and registers this device's Expo push token for the
 * signed-in user. Fails silently on denial, on the Simulator (no real APNs
 * capability), or on any other error -- push is a nice-to-have, never
 * something that should block using the app.
 */
export async function registerForPushNotificationsAsync(userId: string): Promise<void> {
  try {
    await ensureAndroidNotificationChannel();

    const { status: existing } = await Notifications.getPermissionsAsync();
    const status =
      existing === 'granted' ? existing : (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return;

    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });

    const { error } = await supabase
      .from('push_tokens')
      .upsert(
        { user_id: userId, token, platform: Platform.OS === 'ios' ? 'ios' : 'android' },
        { onConflict: 'token' }
      );
    if (error) throw error;
  } catch (e) {
    console.warn('Could not register for push notifications', e);
  }
}
