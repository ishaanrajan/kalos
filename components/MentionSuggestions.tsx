/**
 * A vertical list of accounts to @mention, shown above a composer while an
 * "@partial" is being typed. Candidates are always the viewer's own follows
 * -- who else would you plausibly be tagging -- filtered client-side by
 * prefix match against the query, updating on every keystroke.
 *
 * Stacked vertically (full-width rows, reusing UserRow -- the same row used
 * in search) rather than a horizontal strip: a horizontal row of avatars has
 * to squeeze into whatever width the screen leaves and clips at the edge,
 * where a vertical list just uses the screen's actual width per row.
 */

import React, { useMemo } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import { UserRow } from './UserRow';
import { hairlineWidth, useTheme } from '../lib/theme';
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
      data={matches}
      keyExtractor={(p) => p.id}
      keyboardShouldPersistTaps="handled"
      style={[styles.list, { backgroundColor: colors.surface, borderTopColor: colors.border }]}
      renderItem={({ item }) => <UserRow profile={item} onPress={() => onSelect(item.username)} />}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    // Bounded rather than letting up to 5 full-width rows fight the comment
    // list for space -- scrolls internally past that.
    maxHeight: 260,
    borderTopWidth: hairlineWidth,
  },
});

export default MentionSuggestions;
