import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';
import { ProfileView } from '../../components/ProfileView';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';

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
        <Text style={[styles.title, { color: colors.text }]}>{profile.username}</Text>
      </View>
      <ProfileView profile={profile} isSelf onSignOut={signOut} />
      {/* Purely diagnostic -- what update this exact device is running, since
          "did the update land" was otherwise unanswerable without a device
          log. Safe to remove once OTA delivery is trusted again. */}
      <Text style={[styles.buildTag, { color: colors.textSecondary }]}>
        {Updates.isEmbeddedLaunch ? 'embedded build' : `update ${Updates.updateId?.slice(0, 8) ?? '?'}`}
        {' · '}
        {Updates.createdAt ? Updates.createdAt.toLocaleString() : 'no update timestamp'}
      </Text>
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
  buildTag: {
    position: 'absolute',
    bottom: 6,
    alignSelf: 'center',
    fontSize: 10,
  },
});
