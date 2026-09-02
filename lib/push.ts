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
 * Requests permission and registers this device's Expo push token for the
 * signed-in user. Fails silently on denial, on the Simulator (no real APNs
 * capability), or on any other error -- push is a nice-to-have, never
 * something that should block using the app.
 */
export async function registerForPushNotificationsAsync(userId: string): Promise<void> {
  try {
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
