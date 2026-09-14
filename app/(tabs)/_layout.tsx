import { StyleSheet, View, type ColorValue } from 'react-native';
import { Tabs } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Avatar } from '../../components/Avatar';
import { useExploreLockState, useHasUnreadActivity } from '../../lib/queries';
import { useAuth } from '../../lib/auth';
import { avatarUrl } from '../../lib/supabase';
import { palette, useTheme } from '../../lib/theme';

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
 * Discloses Explore's actual combined lock state up front rather than only
 * on tapping the locked tab -- see useExploreLockState() for the two
 * conditions (5-post threshold, then a daily gate on top).
 */
function ExploreTabIcon({ color, size }: { color: ColorValue; size: number }) {
  const { locked } = useExploreLockState();
  const { colors } = useTheme();
  return (
    <View>
      <Feather name="search" size={size} color={color} />
      {locked ? <View style={[styles.dot, { backgroundColor: colors.heart }]} /> : null}
    </View>
  );
}

/**
 * The camera tab, 2015-style: not just a recolored icon like the other four
 * -- a solid blue rounded-square badge with a white glyph inside it, the
 * one tab that gets a filled button treatment. Ignores the active/inactive
 * tint entirely, active or not, since the reference always shows it the
 * same way regardless of selection.
 */
function CameraTabIcon({ size }: { size: number }) {
  return (
    <View style={[styles.cameraBadge, { width: size + 16, height: size + 16 }]}>
      <Feather name="camera" size={size} color={palette.white} />
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
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        // Fixed, not theme-driven: this bar is meant to look like 2015
        // Instagram's black bar regardless of the phone's light/dark setting.
        tabBarActiveTintColor: palette.tabBarIconActive,
        tabBarInactiveTintColor: palette.tabBarIconInactive,
        tabBarStyle: { backgroundColor: palette.tabBarBackground, borderTopColor: palette.tabBarBackground },
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
        options={{ tabBarIcon: ({ size }) => <CameraTabIcon size={size} /> }}
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
  cameraBadge: {
    backgroundColor: palette.blue,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
