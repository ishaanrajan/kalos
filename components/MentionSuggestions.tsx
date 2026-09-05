/**
 * A horizontal strip of accounts to @mention, shown above a composer while
 * an "@partial" is being typed. Candidates are always the viewer's own
 * follows -- who else would you plausibly be tagging -- filtered client-side
 * by prefix match against the query.
 */

import React, { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text } from 'react-native';
import { Avatar } from './Avatar';
import { avatarUrl } from '../lib/supabase';
import { hairlineWidth, spacing, useTheme } from '../lib/theme';
import type { ProfileSummary } from '../lib/queries';

export interface MentionSuggestionsProps {
  /** The text typed after "@" so far -- empty string shows the full list. */
  query: string;
  candidates: ProfileSummary[];
  onSelect: (username: string) => void;
  /** Most matches to show at once. Defaults to 5. */
  limit?: number;
}

export function MentionSuggestions({ query, candidates, onSelect, limit = 5 }: MentionSuggestionsProps) {
  const { colors } = useTheme();

  const matches = useMemo(() => {
    const q = query.toLowerCase();
    return candidates.filter((p) => p.username.toLowerCase().startsWith(q)).slice(0, limit);
  }, [candidates, query, limit]);

  if (matches.length === 0) return null;

  return (
    <FlatList
      horizontal
      data={matches}
      keyExtractor={(p) => p.id}
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={[styles.list, { backgroundColor: colors.surfaceAlt, borderTopColor: colors.border }]}
      contentContainerStyle={styles.content}
      renderItem={({ item }) => (
        <Pressable style={styles.item} onPress={() => onSelect(item.username)}>
          <Avatar url={avatarUrl(item.avatar_path)} username={item.username} size={28} />
          <Text style={[styles.username, { color: colors.text }]} numberOfLines={1}>
            {item.username}
          </Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    flexGrow: 0,
    borderTopWidth: hairlineWidth,
  },
  content: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  item: {
    alignItems: 'center',
    width: 60,
    marginRight: spacing.md,
  },
  username: {
    fontSize: 11,
    marginTop: spacing.xs,
  },
});

export default MentionSuggestions;
