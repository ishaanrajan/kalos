import { StyleSheet, Text, View, type ColorValue } from 'react-native';
import { Tabs } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Avatar } from '../../components/Avatar';
import { useHasUnreadActivity } from '../../lib/queries';
import { useAuth } from '../../lib/auth';
import { avatarUrl } from '../../lib/supabase';
import { useTheme } from '../../lib/theme';
import { POSTS_TO_UNLOCK } from './explore';

function ActivityTabIcon({ color, size }: { color: ColorValue; size: number }) {
  const hasUnread = useHasUnreadActivity();
  const { colors } = useTheme();
  return (
    <View>
      <Feather name="heart" size={size} color={color} />
      {hasUnread ? <View style={[styles.dot, { backgroundColor: colors.heart }]} /> : null}
    </View>
  );
}

/**
 * A new account has no way to learn Explore needs 5 posts until it actually
 * taps the locked tab -- surfacing the remaining count here (same badge
 * pattern as the unread dots) discloses it up front instead.
 */
function ExploreTabIcon({ color, size }: { color: ColorValue; size: number }) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const remaining = profile ? POSTS_TO_UNLOCK - profile.post_count : 0;
  return (
    <View>
      <Feather name="search" size={size} color={color} />
      {remaining > 0 ? (
        <View style={[styles.badge, { backgroundColor: colors.heart, borderColor: colors.surface }]}>
          <Text style={styles.badgeText} allowFontScaling={false}>
            {remaining}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Instagram's profile tab has always shown the signed-in user's own photo,
 * never a generic person glyph -- falls back to the outline icon only while
 * the profile hasn't loaded yet.
 */
function ProfileTabIcon({ color, size }: { color: ColorValue; size: number }) {
  const { profile } = useAuth();
  if (!profile) {
    return <Feather name="user" size={size} color={color} />;
  }
  return <Avatar url={avatarUrl(profile.avatar_path)} username={profile.username} size={size} />;
}

export default function TabsLayout() {
  const { colors } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ tabBarIcon: ({ color, size }) => <Feather name="home" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="explore"
        options={{ tabBarIcon: ({ color, size }) => <ExploreTabIcon color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="new"
        options={{ tabBarIcon: ({ color, size }) => <Feather name="camera" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="activity"
        options={{ tabBarIcon: ({ color, size }) => <ActivityTabIcon color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="profile"
        options={{ tabBarIcon: ({ color, size }) => <ProfileTabIcon color={color} size={size} /> }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  dot: {
    position: 'absolute',
    top: -1,
    right: -3,
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '700',
  },
});
