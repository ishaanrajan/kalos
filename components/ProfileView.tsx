import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Avatar } from './Avatar';
import { Button } from './Button';
import { PhotoGrid } from './PhotoGrid';
import { EmptyState } from './EmptyState';
import { useIsFollowing, useProfilePosts, useToggleFollow } from '../lib/queries';
import { avatarUrl, photoUrl } from '../lib/supabase';
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

  const header = (
    <View style={styles.header}>
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
          {profile.display_name && <Text style={styles.displayName}>{profile.display_name}</Text>}
          {profile.bio && <Text style={styles.bio}>{profile.bio}</Text>}
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
          <Button
            variant={following ? 'outline' : 'primary'}
            label={following ? 'Following' : 'Follow'}
            onPress={() =>
              toggleFollow.mutate({ profileId: profile.id, following: following ?? false })
            }
            disabled={toggleFollow.isPending}
            style={styles.action}
          />
        )}
      </View>
    </View>
  );

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <PhotoGrid
      posts={posts ?? []}
      imageUrlFor={(p) => photoUrl(p.image_path)}
      onPressPost={(p) => router.push(`/post/${p.id}`)}
      ListHeaderComponent={() => header}
      ListEmptyComponent={
        <EmptyState
          icon="camera"
          title={isSelf ? 'No posts yet' : 'No posts'}
          body={isSelf ? 'Your photos will show up here.' : `${profile.username} hasn't posted yet.`}
        />
      }
    />
  );
}

/** Tappable when there's a list behind it. Post count just scrolls the grid. */
function Stat({ value, label, onPress }: { value: number; label: string; onPress?: () => void }) {
  const body = (
    <>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { paddingHorizontal: 16, paddingTop: 16, backgroundColor: '#fff' },
  topRow: { flexDirection: 'row', alignItems: 'center' },
  stats: { flex: 1, flexDirection: 'row', justifyContent: 'space-around', marginLeft: 16 },
  stat: { alignItems: 'center' },
  statValue: { fontSize: 17, fontWeight: '600', color: '#262626' },
  statLabel: { fontSize: 13, color: '#8e8e8e', marginTop: 2 },
  bioBlock: { marginTop: 14 },
  displayName: { fontSize: 14, fontWeight: '600', color: '#262626' },
  bio: { fontSize: 14, color: '#262626', marginTop: 2, lineHeight: 19 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 16, marginBottom: 16 },
  action: { flex: 1 },
});
