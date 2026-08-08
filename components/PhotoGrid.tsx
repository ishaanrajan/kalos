/**
 * The 3-column square grid used by profiles and Explore.
 *
 * Edge-to-edge with 1px gutters — no outer padding, because the grid is meant
 * to bleed to the screen edges the way it did in 2015.
 */

import React, { useCallback, useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import type { ListRenderItemInfo, StyleProp, ViewStyle } from 'react-native';
import { Image } from 'expo-image';

import { useTheme } from '../lib/theme';
import type { UUID } from '../lib/types';

/** The minimum a grid cell needs: something to key on. */
export interface PhotoGridItem {
  id: UUID;
  caption?: string | null;
}

/** Accepts either a rendered element or a component, like FlatList itself. */
export type ListSlot = React.ComponentType | React.ReactElement | null;

export interface PhotoGridProps<T extends PhotoGridItem> {
  posts: T[];
  /**
   * Resolves a cell's fully-resolved public URL. The screen owns URL building,
   * so the grid never sees a storage path.
   */
  imageUrlFor: (post: T) => string;
  onPressPost: (post: T) => void;
  /**
   * Rendered on top of each cell. Explore uses it for the "Liked by maya" chip
   * that says why a photo reached you; profile grids pass nothing.
   */
  renderOverlay?: (post: T) => React.ReactNode;
  /** Sits above the grid — profile screens put the bio block here. */
  ListHeaderComponent?: ListSlot;
  ListEmptyComponent?: ListSlot;
  ListFooterComponent?: ListSlot;
  onEndReached?: () => void;
  onEndReachedThreshold?: number;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Gutter between cells, in points. Defaults to 1. */
  gutter?: number;
  /**
   * Width the grid is laid out in. Defaults to the window width; pass this when
   * the grid sits inside a padded or split container.
   */
  containerWidth?: number;
  scrollEnabled?: boolean;
  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const COLUMNS = 3;

export function PhotoGrid<T extends PhotoGridItem>({
  posts,
  imageUrlFor,
  onPressPost,
  renderOverlay,
  ListHeaderComponent,
  ListEmptyComponent,
  ListFooterComponent,
  onEndReached,
  onEndReachedThreshold = 0.6,
  onRefresh,
  refreshing,
  gutter = 1,
  containerWidth,
  scrollEnabled = true,
  contentContainerStyle,
  style,
  testID,
}: PhotoGridProps<T>) {
  const { colors } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const width = containerWidth ?? windowWidth;

  // Two gutters sit between three cells; the outer edges stay flush.
  const cellSize = Math.max(1, (width - gutter * (COLUMNS - 1)) / COLUMNS);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<T>) => (
      <Pressable
        onPress={() => onPressPost(item)}
        accessibilityRole="imagebutton"
        accessibilityLabel={item.caption ?? 'Photo'}
        style={({ pressed }) => [
          { width: cellSize, height: cellSize, backgroundColor: colors.imagePlaceholder },
          pressed && styles.pressed,
        ]}
      >
        <Image
          source={imageUrlFor(item)}
          style={styles.image}
          contentFit="cover"
          transition={120}
          cachePolicy="memory-disk"
          recyclingKey={item.id}
          accessible={false}
        />
        {renderOverlay?.(item)}
      </Pressable>
    ),
    [cellSize, colors.imagePlaceholder, imageUrlFor, onPressPost, renderOverlay],
  );

  const keyExtractor = useCallback((item: T) => item.id, []);

  const columnWrapperStyle = useMemo<ViewStyle>(() => ({ gap: gutter }), [gutter]);

  return (
    <FlatList
      data={posts}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      numColumns={COLUMNS}
      columnWrapperStyle={columnWrapperStyle}
      contentContainerStyle={[{ gap: gutter }, contentContainerStyle]}
      style={[{ backgroundColor: colors.background }, style]}
      ListHeaderComponent={ListHeaderComponent}
      ListEmptyComponent={ListEmptyComponent}
      ListFooterComponent={ListFooterComponent}
      onEndReached={onEndReached}
      onEndReachedThreshold={onEndReachedThreshold}
      onRefresh={onRefresh}
      // RN warns if `onRefresh` is set without a boolean `refreshing`.
      refreshing={onRefresh ? (refreshing ?? false) : undefined}
      scrollEnabled={scrollEnabled}
      showsVerticalScrollIndicator={false}
      initialNumToRender={15}
      windowSize={7}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create({
  image: {
    width: '100%',
    height: '100%',
  },
  pressed: {
    opacity: 0.75,
  },
});

export default PhotoGrid;
