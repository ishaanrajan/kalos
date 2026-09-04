import { useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { EmptyState } from '../components/EmptyState';
import { UserRow } from '../components/UserRow';
import { useSearchProfiles, useSuggestedProfiles } from '../lib/queries';
import { useTheme } from '../lib/theme';

/**
 * The only surface in the app that isn't graph-driven — you can look someone
 * up by name. It searches accounts, deliberately not posts or hashtags.
 *
 * Doubles as ishaan's "new message" picker: opened as `/search?intent=dm`
 * (from the DM inbox's compose button), a tap opens a thread instead of a
 * profile.
 *
 * Before anything is typed, the list shows up to 5 suggested accounts
 * (useSuggestedProfiles) instead of sitting empty — the moment there's a
 * query, that list is replaced by real search results.
 */
export default function Search() {
  const router = useRouter();
  const { intent } = useLocalSearchParams<{ intent?: string }>();
  const isDmIntent = intent === 'dm';
  const [q, setQ] = useState('');
  const isSearching = q.trim().length > 0;
  const { data: results } = useSearchProfiles(q);
  const { data: suggested } = useSuggestedProfiles();
  const { colors } = useTheme();
  const data = isSearching ? results ?? [] : suggested ?? [];

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
        data={data}
        keyExtractor={(p) => p.id}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          !isSearching && data.length > 0 ? (
            <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>Suggested</Text>
          ) : null
        }
        ListEmptyComponent={
          isSearching ? (
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
  sectionHeader: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
});
