import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';
import { ProfileView } from '../../components/ProfileView';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';

// Not shown anywhere -- long-press the username at the top of your own
// profile to reveal it. Exists so a friend reporting a stale-looking app can
// be asked "what does this say" instead of guessing whether they actually
// force-quit and relaunched, and "Check for update" gives them a way to pull
// the latest bundle on the spot instead of relying on that at all.
function showBuildInfo() {
  const published = Updates.createdAt ? Updates.createdAt.toLocaleString() : null;
  const message = [
    `Channel: ${Updates.channel ?? '—'}`,
    `Runtime: ${Updates.runtimeVersion ?? '—'}`,
    Updates.isEmbeddedLaunch
      ? 'Running the build embedded in the app -- no OTA update applied.'
      : `Update: ${Updates.updateId ?? '—'}`,
    published ? `Published: ${published}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  Alert.alert('Build info', message, [
    { text: 'Check for update', onPress: checkForUpdateNow },
    { text: 'OK', style: 'cancel' },
  ]);
}

async function checkForUpdateNow() {
  try {
    const result = await Updates.checkForUpdateAsync();
    if (!result.isAvailable) {
      Alert.alert('Up to date', "You're already on the latest update.");
      return;
    }
    await Updates.fetchUpdateAsync();
    Alert.alert('Update downloaded', 'Restarting to apply it now.', [
      { text: 'OK', onPress: () => Updates.reloadAsync() },
    ]);
  } catch (e) {
    Alert.alert('Check failed', e instanceof Error ? e.message : 'Something went wrong.');
  }
}

export default function MyProfile() {
  const { profile, signOut } = useAuth();
  const { colors } = useTheme();

  if (!profile) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: colors.surface }]} edges={['top']}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onLongPress={showBuildInfo} hitSlop={12}>
          <Text style={[styles.title, { color: colors.text }]}>{profile.username}</Text>
        </Pressable>
      </View>
      <ProfileView profile={profile} isSelf onSignOut={signOut} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: '600' },
});
