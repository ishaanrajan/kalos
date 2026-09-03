/**
 * The horizontal filter picker that sits under the photo in the composer.
 *
 * Every thumbnail is a real `FilterPreview` of the user's own photo, because
 * that is the whole point — you pick a filter by seeing it on your picture.
 * To make 18 live canvases affordable the strip renders them all against a
 * single ~150px copy of the source, never the full-resolution bitmap.
 */

import { useImage, type SkImage } from '@shopify/react-native-skia';
import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { downscaleForPreview } from '../lib/bake';
import { FILTERS } from '../lib/filters';
import { useTheme } from '../lib/theme';
import type { Filter } from '../lib/types';
import { FilterPreview, type FilterPreviewSource } from './FilterPreview';

/** Longest edge of the bitmap the thumbnails are drawn from. */
const THUMB_SOURCE_EDGE = 150;
const DEFAULT_THUMB_SIZE = 72;

export interface FilterStripProps {
  /** The composer's photo: an `SkImage` (already downscaled) or a URI. */
  image?: FilterPreviewSource;
  /** Convenience alias for `image` when all you have is a URI. */
  uri?: string | null;
  selectedFilterName: string;
  onSelect: (filterName: string, filter: Filter) => void;
  /** Thumbnail edge length in points. Defaults to 72. */
  thumbSize?: number;
  style?: StyleProp<ViewStyle>;
}

interface ThumbProps {
  filter: Filter;
  image: SkImage | null;
  selected: boolean;
  size: number;
  onSelect: (filterName: string, filter: Filter) => void;
}

const FilterThumb = React.memo(function FilterThumb({
  filter,
  image,
  selected,
  size,
  onSelect,
}: ThumbProps): React.JSX.Element {
  const handlePress = useCallback(() => onSelect(filter.name, filter), [onSelect, filter]);
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={handlePress}
      style={styles.item}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${filter.name} filter`}
    >
      <View
        style={[
          styles.thumbFrame,
          { width: size, height: size, backgroundColor: colors.imagePlaceholder },
          { borderColor: selected ? colors.accent : 'transparent' },
        ]}
      >
        <FilterPreview
          image={image}
          filter={filter}
          strength={1}
          size={{ width: size, height: size }}
          fit="cover"
        />
      </View>
      <Text
        numberOfLines={1}
        style={[
          styles.label,
          { color: selected ? colors.accent : colors.textSecondary },
          selected && styles.labelSelected,
        ]}
        allowFontScaling={false}
      >
        {filter.name}
      </Text>
    </Pressable>
  );
});

export function FilterStrip({
  image,
  uri,
  selectedFilterName,
  onSelect,
  thumbSize = DEFAULT_THUMB_SIZE,
  style,
}: FilterStripProps): React.JSX.Element {
  const { colors } = useTheme();
  const source: FilterPreviewSource = image ?? uri ?? null;

  // When handed a URI, make our own tiny copy first. When handed an SkImage we
  // trust the composer to have already downscaled it.
  const [thumbUri, setThumbUri] = useState<string | null>(null);

  useEffect(() => {
    if (typeof source !== 'string') {
      setThumbUri(null);
      return;
    }
    let cancelled = false;
    const original = source;
    downscaleForPreview(original, THUMB_SOURCE_EDGE)
      .then((result) => {
        if (!cancelled) setThumbUri(result.uri);
      })
      .catch(() => {
        // Downscaling is an optimisation, not a requirement — fall back to the
        // original rather than showing an empty strip.
        if (!cancelled) setThumbUri(original);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const loaded = useImage(thumbUri);
  const thumbImage: SkImage | null = typeof source === 'string' ? loaded : source ?? null;

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Filter>) => (
      <FilterThumb
        filter={item}
        image={thumbImage}
        selected={item.name === selectedFilterName}
        size={thumbSize}
        onSelect={onSelect}
      />
    ),
    [thumbImage, selectedFilterName, thumbSize, onSelect],
  );

  const keyExtractor = useCallback((item: Filter) => item.name, []);

  // Fixed-width cells: let FlatList skip measurement entirely.
  const itemWidth = thumbSize + styles.item.marginHorizontal * 2;
  const getItemLayout = useCallback(
    (_data: ArrayLike<Filter> | null | undefined, index: number) => ({
      length: itemWidth,
      offset: itemWidth * index,
      index,
    }),
    [itemWidth],
  );

  return (
    <FlatList
      horizontal
      data={FILTERS}
      extraData={selectedFilterName}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      getItemLayout={getItemLayout}
      showsHorizontalScrollIndicator={false}
      initialNumToRender={6}
      maxToRenderPerBatch={4}
      windowSize={5}
      removeClippedSubviews
      style={[styles.list, { backgroundColor: colors.background }, style]}
      contentContainerStyle={styles.content}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    flexGrow: 0,
  },
  content: {
    paddingVertical: 10,
    paddingHorizontal: 6,
  },
  item: {
    alignItems: 'center',
    marginHorizontal: 6,
  },
  thumbFrame: {
    overflow: 'hidden',
    borderRadius: 3,
    borderWidth: 2,
  },
  label: {
    marginTop: 6,
    fontSize: 10,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  labelSelected: {
    fontWeight: '600',
  },
});

export default FilterStrip;
