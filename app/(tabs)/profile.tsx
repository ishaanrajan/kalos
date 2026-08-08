import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ProfileView } from '../../components/ProfileView';
import { useAuth } from '../../lib/auth';

export default function MyProfile() {
  const { profile, signOut } = useAuth();

  if (!profile) {
    return (
      <SafeAreaView style={styles.center} edges={['top']}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>{profile.username}</Text>
      </View>
      <ProfileView profile={profile} isSelf onSignOut={signOut} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  header: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#dbdbdb',
  },
  title: { fontSize: 17, fontWeight: '600', color: '#262626' },
});
