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
}

/**
 * One account in a list. Shared by search and by the followers/following
 * lists so a person looks the same wherever you run into them.
 */
export function UserRow({ profile, onPress, accessory }: Props) {
  const { colors } = useTheme();
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Avatar url={avatarUrl(profile.avatar_path)} username={profile.username} size={44} />
      <View style={styles.names}>
        <Text style={[styles.username, { color: colors.text }]}>{profile.username}</Text>
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
  displayName: { fontSize: 13, marginTop: 1 },
});
