import { useState } from 'react';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { EmptyState } from '../components/EmptyState';
import { UserRow } from '../components/UserRow';
import { useSearchProfiles } from '../lib/queries';

/**
 * The only surface in the app that isn't graph-driven — you can look someone
 * up by name. It searches accounts, deliberately not posts or hashtags.
 */
export default function Search() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const { data: results } = useSearchProfiles(q);

  return (
    <View style={styles.root}>
      <TextInput
        style={styles.input}
        placeholder="Search accounts"
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
          <UserRow profile={item} onPress={() => router.push(`/profile/${item.username}`)} />
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
