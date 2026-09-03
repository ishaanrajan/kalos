import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
