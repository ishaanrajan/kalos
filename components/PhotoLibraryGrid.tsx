/**
 * The device's own photo library, rendered in-app as a paginated grid --
 * closer to how Instagram's own composer picks a photo, and avoids handing
 * off to the OS's separate picker UI (which meant a totally blank screen on
 * this side while it was up).
 *
 * expo-media-library's SDK 57 API is a full rewrite of the one from earlier
 * SDKs: assets are `Asset` class instances with only `id` available
 * synchronously -- uri, width, height etc. are all async getters -- and
 * pagination is a `Query` builder (`.limit().offset().exe()`), not the old
 * cursor-based `getAssetsAsync`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import type { ListRenderItemInfo, StyleProp, ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { Asset, AssetField, MediaType, Query } from 'expo-media-library';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../lib/theme';

const COLUMNS = 4;
const PAGE_SIZE = 60;
const GUTTER = 1;

export interface PhotoLibraryGridProps {
  /** The currently selected asset's id, if any -- highlighted in the grid. */
  selectedAssetId?: string | null;
  onSelect: (asset: Asset) => void;
  /** Fired once, with the most recent photo, after the first page loads --
   * lets the composer default-select it the way Instagram's own picker does. */
  onFirstLoad?: (asset: Asset) => void;
  containerWidth?: number;
  style?: StyleProp<ViewStyle>;
}

export function PhotoLibraryGrid({
  selectedAssetId,
  onSelect,
  onFirstLoad,
  containerWidth,
  style,
}: PhotoLibraryGridProps) {
  const { colors } = useTheme();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [page, setPage] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(true);
  const loadingRef = useRef(false);
  // Guards the very first page load against React's dev-mode double-invoke
  // of effects.
  const startedRef = useRef(false);
  // A ref, not a dependency of loadPage -- the caller's callback identity
  // shouldn't force this to be recreated.
  const onFirstLoadRef = useRef(onFirstLoad);
  onFirstLoadRef.current = onFirstLoad;

  const loadPage = useCallback(async (pageToLoad: number) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const results = await new Query()
        .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
        .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
        .limit(PAGE_SIZE)
        .offset(pageToLoad * PAGE_SIZE)
        .exe();
      setAssets((prev) => (pageToLoad === 0 ? results : [...prev, ...results]));
      setHasNextPage(results.length === PAGE_SIZE);
      setPage(pageToLoad);
      if (pageToLoad === 0 && results.length > 0) {
        onFirstLoadRef.current?.(results[0]!);
      }
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void loadPage(0);
  }, [loadPage]);

  const onEndReached = useCallback(() => {
    if (hasNextPage) void loadPage(page + 1);
  }, [hasNextPage, page, loadPage]);

  const cellSize = Math.max(1, ((containerWidth ?? 0) - GUTTER * (COLUMNS - 1)) / COLUMNS);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Asset>) => (
      <GridCell
        asset={item}
        size={cellSize}
        selected={item.id === selectedAssetId}
        placeholderColor={colors.imagePlaceholder}
        accentColor={colors.accent}
        onPress={onSelect}
      />
    ),
    [cellSize, colors.imagePlaceholder, colors.accent, onSelect, selectedAssetId]
  );

  const keyExtractor = useCallback((item: Asset) => item.id, []);

  return (
    <FlatList
      data={assets}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      numColumns={COLUMNS}
      columnWrapperStyle={styles.row}
      contentContainerStyle={styles.content}
      style={[{ backgroundColor: colors.surface }, style]}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.6}
      showsVerticalScrollIndicator={false}
      initialNumToRender={24}
      windowSize={7}
      removeClippedSubviews
    />
  );
}

/**
 * The new API only exposes an asset's uri via an async getter (no more
 * plain `.uri` field) -- resolved once per cell here rather than the grid
 * re-resolving it on every re-render.
 */
function GridCell({
  asset,
  size,
  selected,
  placeholderColor,
  accentColor,
  onPress,
}: {
  asset: Asset;
  size: number;
  selected: boolean;
  placeholderColor: string;
  accentColor: string;
  onPress: (asset: Asset) => void;
}) {
  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    asset
      .getUri()
      .then((resolved) => {
        if (!cancelled) setUri(resolved);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [asset]);

  return (
    <Pressable
      onPress={() => onPress(asset)}
      accessibilityRole="imagebutton"
      accessibilityLabel="Photo"
      style={{ width: size, height: size, backgroundColor: placeholderColor }}
    >
      {uri ? (
        <Image
          source={uri}
          style={styles.image}
          contentFit="cover"
          transition={100}
          recyclingKey={asset.id}
          accessible={false}
        />
      ) : null}
      {selected ? (
        <View style={[styles.selectedOverlay, { borderColor: accentColor }]}>
          <View style={[styles.selectedDot, { backgroundColor: accentColor }]}>
            <Ionicons name="checkmark" size={12} color="#fff" />
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { gap: GUTTER },
  content: { gap: GUTTER },
  image: { width: '100%', height: '100%' },
  selectedOverlay: {
    ...StyleSheet.absoluteFill,
    borderWidth: 2,
    alignItems: 'flex-end',
    padding: 4,
  },
  selectedDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default PhotoLibraryGrid;
