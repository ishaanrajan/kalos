/**
 * The composer's "Tag people" step, the 2015 way: the photo fills the width,
 * you tap where a person is, pick who from the people you follow, and a
 * username bubble lands on that spot. Tapping a bubble removes it.
 *
 * Two modes, switched on whether a tap is waiting for a name:
 *
 * - Photo mode shows the filtered photo (the same Skia preview the filter
 *   step uses, at the same size, so the fraction a tap produces here means
 *   the same thing when PostCard draws it later -- see PostTag in
 *   lib/types.ts) with the current bubbles over it.
 * - Pick mode replaces it with a search box over the follow list, filtered
 *   by the same prefix match MentionSuggestions uses. Candidates are the
 *   people you follow rather than a server search: at this app's size that
 *   is the whole plausible set, and it's already in the query cache from
 *   the comment composer.
 *
 * The tap is caught by a transparent Pressable laid over the canvas rather
 * than by the canvas itself, so this never depends on Skia's view passing
 * touches up to a parent.
 */

import type { SkImage } from '@shopify/react-native-skia';
import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
} from 'react-native';

import type { ProfileSummary } from '../lib/queries';
import { hairlineWidth, spacing, useTheme } from '../lib/theme';
import type { Filter, PostTag } from '../lib/types';
import { EmptyState } from './EmptyState';
import { FilterPreview } from './FilterPreview';
import { TagBubble } from './TagBubble';
import { UserRow } from './UserRow';

/** Mirrors the backstop trigger in 0034_post_tags.sql. */
export const MAX_TAGS_PER_POST = 20;

export interface TagPeopleEditorProps {
  /** The decoded composer image (decoded once, shared with every preview). */
  image: SkImage | null;
  filter: Filter;
  /** The photo's on-screen size -- SCREEN wide, at the post's display ratio. */
  frame: { width: number; height: number };
  tags: PostTag[];
  onChangeTags: (tags: PostTag[]) => void;
  /** The people the author follows. */
  candidates: ProfileSummary[];
}

type Spot = { x: number; y: number };

export function TagPeopleEditor({
  image,
  filter,
  frame,
  tags,
  onChangeTags,
  candidates,
}: TagPeopleEditorProps) {
  const { colors } = useTheme();
  const [pendingSpot, setPendingSpot] = useState<Spot | null>(null);
  const [query, setQuery] = useState('');

  const atCap = tags.length >= MAX_TAGS_PER_POST;

  const onPressPhoto = (e: GestureResponderEvent) => {
    if (atCap) return;
    const { locationX, locationY } = e.nativeEvent;
    setPendingSpot({
      x: round4(clamp01(locationX / frame.width)),
      y: round4(clamp01(locationY / frame.height)),
    });
  };

  const remove = (userId: string) => onChangeTags(tags.filter((t) => t.user_id !== userId));

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const tagged = new Set(tags.map((t) => t.user_id));
    return candidates.filter(
      (p) => !tagged.has(p.id) && p.username.toLowerCase().startsWith(q),
    );
  }, [candidates, query, tags]);

  const pick = (p: ProfileSummary) => {
    if (!pendingSpot) return;
    onChangeTags([...tags, { user_id: p.id, username: p.username, x: pendingSpot.x, y: pendingSpot.y }]);
    setPendingSpot(null);
    setQuery('');
  };

  if (pendingSpot) {
    return (
      <View style={[styles.root, { backgroundColor: colors.surface }]}>
        <View style={[styles.searchRow, { borderBottomColor: colors.border }]}>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surfaceAlt, color: colors.text }]}
            placeholder="Search people you follow"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            value={query}
            onChangeText={setQuery}
            accessibilityLabel="Search people to tag"
          />
          <Pressable
            onPress={() => {
              setPendingSpot(null);
              setQuery('');
            }}
            hitSlop={10}
            accessibilityRole="button"
          >
            <Text style={[styles.cancel, { color: colors.text }]}>Cancel</Text>
          </Pressable>
        </View>
        <FlatList
          data={matches}
          keyExtractor={(p) => p.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          renderItem={({ item }) => <UserRow profile={item} onPress={() => pick(item)} />}
          ListEmptyComponent={
            candidates.length === 0 ? (
              <EmptyState
                icon="users"
                title="No one to tag yet"
                body="You can tag the people you follow."
                style={styles.empty}
              />
            ) : (
              <EmptyState icon="search" title="No results" style={styles.empty} />
            )
          }
        />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.surface }]}>
      <Text style={[styles.hint, { color: colors.textSecondary }]}>
        {atCap ? `You can tag up to ${MAX_TAGS_PER_POST} people` : 'Tap the photo to tag someone'}
      </Text>
      <View style={{ width: frame.width, height: frame.height }}>
        <FilterPreview
          image={image}
          filter={filter}
          strength={1}
          size={frame}
          style={{ backgroundColor: colors.imagePlaceholder }}
        />
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onPressPhoto}
          accessibilityRole="image"
          accessibilityLabel="Photo. Tap to tag someone"
        />
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {tags.map((t) => (
            <TagBubble
              key={t.user_id}
              username={t.username}
              x={t.x}
              y={t.y}
              frame={frame}
              onRemove={() => remove(t.user_id)}
            />
          ))}
        </View>
      </View>
      {tags.length > 0 ? (
        <Text style={[styles.hint, { color: colors.textSecondary }]}>Tap a name to remove it</Text>
      ) : null}
    </View>
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  hint: {
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: hairlineWidth,
    paddingRight: 12,
  },
  input: {
    flex: 1,
    margin: 12,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  cancel: {
    fontSize: 15,
  },
  empty: {
    marginTop: 32,
  },
});

export default TagPeopleEditor;
