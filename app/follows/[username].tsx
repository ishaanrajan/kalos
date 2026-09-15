import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { EmptyState } from '../../components/EmptyState';
import { UserRow } from '../../components/UserRow';
import { isNotFoundError, useFollowList, useProfile, type FollowListKind } from '../../lib/queries';
import { useTheme } from '../../lib/theme';

/**
 * The people behind the two numbers on a profile. One screen with a segmented
 * toggle rather than two routes, so switching between them doesn't push a new
 * screen onto the stack every time.
 */
export default function Follows() {
  const router = useRouter();
  const { username, tab } = useLocalSearchParams<{ username: string; tab?: string }>();
  const { colors } = useTheme();

  const [kind, setKind] = useState<FollowListKind>(
    tab === 'following' ? 'following' : 'followers'
  );

  const {
    data: profile,
    isLoading: loadingProfile,
    isError: profileError,
    error: profileErr,
    refetch: refetchProfile,
  } = useProfile(username);
  const {
    data: people,
    isLoading: loadingList,
    isError: listError,
    refetch: refetchList,
  } = useFollowList(profile?.id, kind);

  if (loadingProfile) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator />
      </View>
    );
  }

  // Same distinction as app/profile/[username].tsx: a request that didn't
  // get through is not a missing account.
  if (profileError && !isNotFoundError(profileErr)) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <EmptyState
          icon="alert-circle"
          title="Couldn't load this profile"
          body={profileErr instanceof Error ? profileErr.message : 'Something went wrong.'}
          actionLabel="Try again"
          onAction={() => refetchProfile()}
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

      <View style={[styles.tabs, { borderBottomColor: colors.border }]}>
        <Tab
          label="Followers"
          count={profile.follower_count}
          active={kind === 'followers'}
          onPress={() => setKind('followers')}
        />
        <Tab
          label="Following"
          count={profile.following_count}
          active={kind === 'following'}
          onPress={() => setKind('following')}
        />
      </View>

      {loadingList ? (
        <View style={[styles.center, { backgroundColor: colors.surface }]}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={people ?? []}
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => (
            <UserRow profile={item} onPress={() => router.push(`/profile/${item.username}`)} />
          )}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            // With retry: 1 app-wide, two failed requests in a tunnel used to
            // tell someone they had no followers.
            listError ? (
              <EmptyState
                icon="alert-circle"
                title="Couldn't load this list"
                actionLabel="Try again"
                onAction={() => refetchList()}
              />
            ) : kind === 'followers' ? (
              <EmptyState
                icon="users"
                title="No followers yet"
                body={`Nobody follows @${profile.username} yet.`}
              />
            ) : (
              <EmptyState
                icon="users"
                title="Not following anyone"
                body={`@${profile.username} hasn't followed anyone yet.`}
              />
            )
          }
        />
      )}
    </View>
  );
}

function Tab({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      style={[styles.tab, { borderBottomColor: active ? colors.text : 'transparent' }]}
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
    >
      <Text
        style={[
          styles.tabText,
          { color: active ? colors.text : colors.textSecondary },
          active && styles.tabTextActive,
        ]}
      >
        {count} {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  tabText: { fontSize: 14 },
  tabTextActive: { fontWeight: '600' },
  list: { paddingVertical: 8 },
});
