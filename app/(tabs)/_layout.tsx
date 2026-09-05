import { StyleSheet, View, type ColorValue } from 'react-native';
import { Tabs } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Avatar } from '../../components/Avatar';
import { useHasPostedToday, useHasUnreadActivity } from '../../lib/queries';
import { useAuth } from '../../lib/auth';
import { avatarUrl } from '../../lib/supabase';
import { useTheme } from '../../lib/theme';

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
 * Explore's unlock is a daily gate now (post today or it's locked), not a
 * cumulative count, so there's no "N more to go" number left to show --
 * just whether today specifically still needs a post, disclosed here rather
 * than only on tapping the locked tab.
 */
function ExploreTabIcon({ color, size }: { color: ColorValue; size: number }) {
  const postedToday = useHasPostedToday();
  const { colors } = useTheme();
  return (
    <View>
      <Feather name="search" size={size} color={color} />
      {postedToday.data === false ? (
        <View style={[styles.dot, { backgroundColor: colors.heart }]} />
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
});
