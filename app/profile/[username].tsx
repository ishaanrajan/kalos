import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { ProfileView } from '../../components/ProfileView';
import { EmptyState } from '../../components/EmptyState';
import { isNotFoundError, useProfile } from '../../lib/queries';
import { useUserId } from '../../lib/auth';
import { useTheme } from '../../lib/theme';

export default function ProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { data: profile, isLoading, isError, error, refetch } = useProfile(username);
  const userId = useUserId();
  const { colors } = useTheme();

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator />
      </View>
    );
  }

  // A network failure is not a missing account. Tapping a username from a
  // comment on a flaky connection used to read as the person having deleted
  // their profile, with no way to try again.
  if (isError && !isNotFoundError(error)) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <EmptyState
          icon="alert-circle"
          title="Couldn't load this profile"
          body={error instanceof Error ? error.message : 'Something went wrong.'}
          actionLabel="Try again"
          onAction={() => refetch()}
        />
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <EmptyState icon="user-x" title="No such account" body={`Couldn't find @${username}.`} />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.surface }]}>
      <Stack.Screen options={{ title: profile.username }} />
      <ProfileView profile={profile} isSelf={profile.id === userId} onRefreshProfile={refetch} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
