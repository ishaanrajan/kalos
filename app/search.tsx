import { useState } from 'react';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { EmptyState } from '../components/EmptyState';
import { UserRow } from '../components/UserRow';
import { useSearchProfiles } from '../lib/queries';

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

  return (
    <View style={styles.root}>
      {isDmIntent && <Stack.Screen options={{ title: 'New message' }} />}
      <TextInput
        style={styles.input}
        placeholder={isDmIntent ? 'Search people to message' : 'Search accounts'}
        placeholderTextColor="#8e8e8e"
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
  root: { flex: 1, backgroundColor: '#fff' },
  input: {
    margin: 12,
    backgroundColor: '#efefef',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#262626',
  },
});
