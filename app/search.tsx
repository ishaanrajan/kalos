import { useState } from 'react';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { EmptyState } from '../components/EmptyState';
import { UserRow } from '../components/UserRow';
import { useSearchProfiles } from '../lib/queries';
import { useTheme } from '../lib/theme';

/**
 * The only surface in the app that isn't graph-driven — you can look someone
 * up by name. It searches accounts, deliberately not posts or hashtags.
 *
 * Doubles as ishaan's "new message" picker: opened as `/search?intent=dm`
 * (from the DM inbox's compose button), a tap opens a thread instead of a
 * profile.
 */
export default function Search() {
  const router = useRouter();
  const { intent } = useLocalSearchParams<{ intent?: string }>();
  const isDmIntent = intent === 'dm';
  const [q, setQ] = useState('');
  const { data: results } = useSearchProfiles(q);
  const { colors } = useTheme();

  return (
    <View style={[styles.root, { backgroundColor: colors.surface }]}>
      {isDmIntent && <Stack.Screen options={{ title: 'New message' }} />}
      <TextInput
        style={[styles.input, { backgroundColor: colors.surfaceAlt, color: colors.text }]}
        placeholder={isDmIntent ? 'Search people to message' : 'Search accounts'}
        placeholderTextColor={colors.textSecondary}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        value={q}
        onChangeText={setQ}
      />

      <FlatList
        data={results ?? []}
        keyExtractor={(p) => p.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          q.trim() ? (
            <EmptyState icon="search" title="No accounts found" body={`Nothing matching "${q}".`} />
          ) : null
        }
        renderItem={({ item }) => (
          <UserRow
            profile={item}
            onPress={() =>
              router.push(isDmIntent ? `/dm/${item.username}` : `/profile/${item.username}`)
            }
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  input: {
    margin: 12,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
});
