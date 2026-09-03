import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { ProfileView } from '../../components/ProfileView';
import { EmptyState } from '../../components/EmptyState';
import { useProfile } from '../../lib/queries';
import { useUserId } from '../../lib/auth';
import { useTheme } from '../../lib/theme';

export default function ProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { data: profile, isLoading, isError } = useProfile(username);
  const userId = useUserId();
  const { colors } = useTheme();

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator />
      </View>
    );
  }

  if (isError || !profile) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <EmptyState icon="user-x" title="No such account" body={`Couldn't find @${username}.`} />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.surface }]}>
      <Stack.Screen options={{ title: profile.username }} />
      <ProfileView profile={profile} isSelf={profile.id === userId} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
