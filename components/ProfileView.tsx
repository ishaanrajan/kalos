import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Avatar } from './Avatar';
import { Button } from './Button';
import { PhotoGrid } from './PhotoGrid';
import { EmptyState } from './EmptyState';
import { useIsFollowing, useProfilePosts, useToggleFollow } from '../lib/queries';
import { avatarUrl, photoUrl } from '../lib/supabase';
import { useTheme } from '../lib/theme';
import type { Profile } from '../lib/types';

interface Props {
  profile: Profile;
  /** True when this is the signed-in user's own profile. */
  isSelf: boolean;
  onSignOut?: () => void;
}

export function ProfileView({ profile, isSelf, onSignOut }: Props) {
  const router = useRouter();
  const { data: posts, isLoading } = useProfilePosts(profile.id);
  const { data: following } = useIsFollowing(isSelf ? undefined : profile.id);
  const toggleFollow = useToggleFollow();
  const { colors } = useTheme();

  const header = (
    <View style={[styles.header, { backgroundColor: colors.surface }]}>
      <View style={styles.topRow}>
        <Avatar url={avatarUrl(profile.avatar_path)} username={profile.username} size={80} />
        <View style={styles.stats}>
          <Stat value={profile.post_count} label="posts" />
          <Stat
            value={profile.follower_count}
            label="followers"
            onPress={() => router.push(`/follows/${profile.username}?tab=followers`)}
          />
          <Stat
            value={profile.following_count}
            label="following"
            onPress={() => router.push(`/follows/${profile.username}?tab=following`)}
          />
        </View>
      </View>

      {(profile.display_name || profile.bio) && (
        <View style={styles.bioBlock}>
          {profile.display_name && (
            <Text style={[styles.displayName, { color: colors.text }]}>{profile.display_name}</Text>
          )}
          {profile.bio && <Text style={[styles.bio, { color: colors.text }]}>{profile.bio}</Text>}
        </View>
      )}

      <View style={styles.actions}>
        {isSelf ? (
          <>
            <Button
              variant="outline"
              label="Edit profile"
              onPress={() => router.push('/edit-profile')}
              style={styles.action}
            />
            {/* Reached via the profile tab, which supplies onSignOut. Viewing
                your own profile through a username link has nothing to log
                out of. */}
            {onSignOut && (
              <Button variant="outline" label="Log out" onPress={onSignOut} style={styles.action} />
            )}
          </>
        ) : (
          <>
            <Button
              variant={following ? 'outline' : 'primary'}
              label={following ? 'Following' : 'Follow'}
              onPress={() =>
                toggleFollow.mutate(
                  { profileId: profile.id, following: following ?? false },
                  {
                    onError: (e) =>
                      Alert.alert(
                        following ? 'Could not unfollow' : 'Could not follow',
                        e instanceof Error ? e.message : undefined
                      ),
                  }
                )
              }
              disabled={toggleFollow.isPending}
              style={styles.action}
            />
            {/* The only other account (besides ishaan) allowed to write into
                someone else's DM thread -- see 0014_dm_multi_thread.sql --
                so it's the only profile that gets its own Message entry
                point. A regular user reaches their ishaan thread via the
                Home tab's message icon instead. */}
            {profile.username === 'prosecco_daddy' && (
              <Button
                variant="outline"
                label="Message"
                onPress={() => router.push(`/dm/${profile.username}`)}
                style={styles.action}
              />
            )}
          </>
        )}
      </View>
    </View>
  );

  return (
    <PhotoGrid
      posts={posts ?? []}
      imageUrlFor={(p) => photoUrl(p.image_path)}
      onPressPost={(p) => router.push(`/post/${p.id}`)}
      ListHeaderComponent={() => header}
      ListEmptyComponent={
        // The header (avatar, counts, bio) is already in memory and has
        // nothing to wait on — only the grid below it depends on the posts
        // query, so that's the only part allowed to show a spinner.
        isLoading ? (
          <View style={styles.gridLoading}>
            <ActivityIndicator />
          </View>
        ) : (
          <EmptyState
            icon="camera"
            title={isSelf ? 'No posts yet' : 'No posts'}
            body={isSelf ? 'Your photos will show up here.' : `${profile.username} hasn't posted yet.`}
          />
        )
      }
    />
  );
}

/** Tappable when there's a list behind it. Post count just scrolls the grid. */
function Stat({ value, label, onPress }: { value: number; label: string; onPress?: () => void }) {
  const { colors } = useTheme();
  const body = (
    <>
      <Text style={[styles.statValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{label}</Text>
    </>
  );

  if (!onPress) return <View style={styles.stat}>{body}</View>;

  return (
    <Pressable
      style={styles.stat}
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={`${value} ${label}`}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  gridLoading: { alignItems: 'center', paddingVertical: 48 },
  header: { paddingHorizontal: 16, paddingTop: 16 },
  topRow: { flexDirection: 'row', alignItems: 'center' },
  stats: { flex: 1, flexDirection: 'row', justifyContent: 'space-around', marginLeft: 16 },
  stat: { alignItems: 'center' },
  statValue: { fontSize: 17, fontWeight: '600' },
  statLabel: { fontSize: 13, marginTop: 2 },
  bioBlock: { marginTop: 14 },
  displayName: { fontSize: 14, fontWeight: '600' },
  bio: { fontSize: 14, marginTop: 2, lineHeight: 19 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 16, marginBottom: 16 },
  action: { flex: 1 },
});
