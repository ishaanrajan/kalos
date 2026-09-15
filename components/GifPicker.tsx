/**
 * A GIF comment's picker: search GIPHY, tap a result to send it immediately.
 *
 * Results play in the grid. The cell's source is GIPHY's downsampled
 * animated rendition (see Gif.previewGifUrl), with the static still as the
 * placeholder so a cell paints the instant its frame is known and starts
 * moving when the animation arrives -- a grid of frozen first frames read
 * as "which one is this?" for every result.
 *
 * Deliberately simpler than MusicPicker -- there's no scrub/trim step and no
 * audition player, since a GIF is either right or it isn't; tapping a result
 * just calls onSelect and the caller (CommentComposer) submits it as its own
 * comment right away, sticker-style.
 *
 * The "Powered By GIPHY" line at the bottom is not decoration -- see
 * lib/giphy.ts for the attribution obligation it satisfies.
 */

import { useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useGifSearch } from '../lib/queries';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import type { Gif } from '../lib/giphy';
import { hairlineWidth, radius, spacing, useTheme } from '../lib/theme';

/** Same reasoning as MusicPicker's SEARCH_DEBOUNCE_MS -- settle before spending a call. */
const SEARCH_DEBOUNCE_MS = 350;
const COLUMNS = 3;

export interface GifPickerProps {
  visible: boolean;
  onSelect: (gif: Gif) => void;
  onClose: () => void;
}

export function GifPicker({ visible, onSelect, onClose }: GifPickerProps) {
  const { colors, typography } = useTheme();
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const { data: results, isFetching, isError } = useGifSearch(debouncedQuery);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.root, { backgroundColor: colors.surface }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Text style={[typography.username, { color: colors.text }]}>Send a GIF</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
            <Ionicons name="close" size={22} color={colors.text} />
          </Pressable>
        </View>

        <View style={[styles.searchRow, { backgroundColor: colors.surfaceAlt }]}>
          <Ionicons name="search" size={15} color={colors.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search GIFs…"
            placeholderTextColor={colors.textSecondary}
            value={query}
            onChangeText={setQuery}
            autoFocus
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
            </Pressable>
          ) : null}
        </View>

        {isError ? (
          <Text style={[typography.timestamp, styles.status, { color: colors.textSecondary }]}>
            Could not reach the GIF catalog.
          </Text>
        ) : null}

        <FlatList
          data={results ?? []}
          keyExtractor={(g) => g.id}
          numColumns={COLUMNS}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          style={styles.list}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={isFetching ? <ActivityIndicator style={styles.spinner} size="small" /> : null}
          ListEmptyComponent={
            // Only once a real search has come back empty -- not while it's
            // still in flight, and not before anything's been typed.
            debouncedQuery.trim() && results && !isFetching && !isError ? (
              <Text style={[typography.timestamp, styles.status, { color: colors.textSecondary }]}>
                {`No GIFs for “${debouncedQuery.trim()}”`}
              </Text>
            ) : null
          }
          ListFooterComponent={
            <Text style={[typography.timestamp, styles.attribution, { color: colors.textSecondary }]}>
              Powered By GIPHY
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onSelect(item)}
              style={styles.cell}
              accessibilityRole="button"
              accessibilityLabel="Send this GIF"
            >
              <Image
                source={item.previewGifUrl}
                placeholder={item.previewUrl}
                placeholderContentFit="cover"
                style={[styles.cellImage, { aspectRatio: item.width / item.height, backgroundColor: colors.imagePlaceholder }]}
                contentFit="cover"
                recyclingKey={item.id}
                cachePolicy="memory-disk"
              />
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: hairlineWidth,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    height: 36,
    borderRadius: radius.md,
  },
  searchInput: { flex: 1, marginLeft: spacing.sm, fontSize: 15 },
  status: { marginHorizontal: spacing.lg, marginTop: spacing.md },
  list: { flex: 1, marginTop: spacing.md },
  listContent: { paddingHorizontal: spacing.sm },
  spinner: { marginVertical: spacing.md },
  cell: { flex: 1 / COLUMNS, padding: spacing.xs },
  cellImage: { width: '100%', borderRadius: radius.sm },
  attribution: { textAlign: 'center', paddingVertical: spacing.xl },
});
