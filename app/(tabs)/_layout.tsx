import { Tabs } from 'expo-router';
import { Feather } from '@expo/vector-icons';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarActiveTintColor: '#262626',
        tabBarInactiveTintColor: '#8e8e8e',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ tabBarIcon: ({ color, size }) => <Feather name="home" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="explore"
        options={{ tabBarIcon: ({ color, size }) => <Feather name="compass" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="new"
        options={{ tabBarIcon: ({ color, size }) => <Feather name="plus-square" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="activity"
        options={{ tabBarIcon: ({ color, size }) => <Feather name="heart" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="profile"
        options={{ tabBarIcon: ({ color, size }) => <Feather name="user" size={size} color={color} /> }}
      />
    </Tabs>
  );
}
