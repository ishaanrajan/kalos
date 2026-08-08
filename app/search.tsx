import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Avatar } from '../components/Avatar';
import { EmptyState } from '../components/EmptyState';
import { useSearchProfiles } from '../lib/queries';
import { avatarUrl } from '../lib/supabase';

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
          <Pressable style={styles.row} onPress={() => router.push(`/profile/${item.username}`)}>
            <Avatar url={avatarUrl(item.avatar_path)} username={item.username} size={44} />
            <View style={styles.names}>
              <Text style={styles.username}>{item.username}</Text>
              {item.display_name && <Text style={styles.displayName}>{item.display_name}</Text>}
            </View>
          </Pressable>
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  names: { flex: 1 },
  username: { fontSize: 14, fontWeight: '600', color: '#262626' },
  displayName: { fontSize: 13, color: '#8e8e8e', marginTop: 1 },
});
