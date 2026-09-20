import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar } from './Avatar';
import { avatarUrl } from '../lib/supabase';
import { useTheme } from '../lib/theme';
import type { ProfileSummary } from '../lib/queries';

interface Props {
  profile: ProfileSummary;
  onPress: () => void;
  /** Rendered at the trailing edge -- a follow button on the follow lists. */
  accessory?: React.ReactNode;
  /**
   * Bolder than the row's own default weight, the way an unread thread's
   * name reads in iMessage. Nothing sets this outside the DM inbox -- every
   * other list this row appears in (search, followers/following) has no
   * concept of "unread" and keeps the plain default.
   */
  unread?: boolean;
}

/**
 * One account in a list. Shared by search and by the followers/following
 * lists so a person looks the same wherever you run into them.
 */
export function UserRow({ profile, onPress, accessory, unread }: Props) {
  const { colors } = useTheme();
  return (
    <Pressable
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        profile.display_name ? `${profile.username}, ${profile.display_name}` : profile.username
      }
    >
      <Avatar url={avatarUrl(profile.avatar_path)} username={profile.username} size={44} />
      <View style={styles.names}>
        <Text style={[styles.username, { color: colors.text }, unread && styles.unread]}>
          {profile.username}
        </Text>
        {profile.display_name && (
          <Text style={[styles.displayName, { color: colors.textSecondary }]}>
            {profile.display_name}
          </Text>
        )}
      </View>
      {accessory}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  names: { flex: 1 },
  username: { fontSize: 14, fontWeight: '600' },
  unread: { fontWeight: '800' },
  displayName: { fontSize: 13, marginTop: 1 },
});
