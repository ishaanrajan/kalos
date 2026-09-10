/**
 * The device's own photo library, rendered in-app as a full-bleed paginated
 * grid -- closer to how Instagram's own composer picks a photo, and avoids
 * handing off to the OS's separate picker UI (which meant a totally blank
 * screen on this side while it was up).
 *
 * Tapping a cell picks it immediately -- there's no separate "selected, now
 * confirm" step, because the very next screen (CropAdjust) is already a full
 * preview of the photo, so a duplicate preview here was just a second look at
 * the same thing before you could act on it.
 *
 * expo-media-library's SDK 57 API is a full rewrite of the one from earlier
 * SDKs: assets are `Asset` class instances with only `id` available
 * synchronously -- uri, width, height etc. are all async getters -- and
 * pagination is a `Query` builder (`.limit().offset().exe()`), not the old
 * cursor-based `getAssetsAsync`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import type { ListRenderItemInfo, StyleProp, ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { Asset, AssetField, MediaType, Query } from 'expo-media-library';

import { useTheme } from '../lib/theme';

const COLUMNS = 4;
const PAGE_SIZE = 60;
const GUTTER = 1;

/**
 * asset.getUri() is a native-bridge round trip per call. FlatList's own
 * windowing unmounts cells that scroll out of range (see `windowSize` below)
 * and remounts them from scratch on the way back in -- without a cache kept
 * outside any one cell's lifetime, scrolling back up over photos already
 * seen this session re-paid that round trip for every single one of them,
 * which is what "scrolling and it lags a lot" was: a burst of native calls
 * queued up behind every direction change.
 *
 * Module-level, not per-grid-instance -- the id -> uri mapping is stable for
 * the life of the app (an asset's uri doesn't change), so there's no reason
 * to lose it when this screen unmounts and pay for it again next time the
 * composer opens.
 */
const uriCache = new Map<string, string>();

export interface PhotoLibraryGridProps {
  /** Fired the moment a photo's tapped. The grid doesn't track a "selected"
   * concept beyond that -- there is nothing to confirm afterward. */
  onPick: (asset: Asset) => void;
  containerWidth?: number;
  style?: StyleProp<ViewStyle>;
}

export function PhotoLibraryGrid({ onPick, containerWidth, style }: PhotoLibraryGridProps) {
  const { colors } = useTheme();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [page, setPage] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(true);
  // The one cell currently resolving getInfo() after a tap -- shown with a
  // spinner in place of the thumbnail, and taps elsewhere are ignored while
  // it's set so a second tap can't race the first into the adjust step.
  const [pickingId, setPickingId] = useState<string | null>(null);
  const loadingRef = useRef(false);
  // Guards the very first page load against React's dev-mode double-invoke
  // of effects.
  const startedRef = useRef(false);

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

  const handlePress = useCallback(
    (asset: Asset) => {
      if (pickingId) return;
      setPickingId(asset.id);
      onPick(asset);
    },
    [pickingId, onPick]
  );

  const cellSize = Math.max(1, ((containerWidth ?? 0) - GUTTER * (COLUMNS - 1)) / COLUMNS);

  // Fixed-size cells laid out in fixed-height rows -- telling FlatList the
  // geometry up front means it never has to measure a row before it can
  // scroll to it, which is the other half of "scrolling lags": without this
  // every fling recomputes layout for rows it hasn't rendered yet.
  const getItemLayout = useCallback(
    (_data: ArrayLike<Asset> | null | undefined, index: number) => {
      const length = cellSize + GUTTER;
      return { length, offset: length * Math.floor(index / COLUMNS), index };
    },
    [cellSize]
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Asset>) => (
      <GridCell
        asset={item}
        size={cellSize}
        picking={item.id === pickingId}
        dimmed={pickingId !== null && item.id !== pickingId}
        placeholderColor={colors.imagePlaceholder}
        onPress={handlePress}
      />
    ),
    [cellSize, pickingId, colors.imagePlaceholder, handlePress]
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
      getItemLayout={getItemLayout}
      initialNumToRender={24}
      maxToRenderPerBatch={24}
      windowSize={9}
    />
  );
}

/**
 * The new API only exposes an asset's uri via an async getter (no more
 * plain `.uri` field) -- resolved once per cell and stashed in the
 * module-level cache above, so scrolling a photo back into view after it's
 * been seen once this session is a synchronous cache read, not another
 * native call.
 */
function GridCell({
  asset,
  size,
  picking,
  dimmed,
  placeholderColor,
  onPress,
}: {
  asset: Asset;
  size: number;
  picking: boolean;
  dimmed: boolean;
  placeholderColor: string;
  onPress: (asset: Asset) => void;
}) {
  const [uri, setUri] = useState<string | null>(() => uriCache.get(asset.id) ?? null);

  useEffect(() => {
    const cached = uriCache.get(asset.id);
    if (cached) {
      setUri(cached);
      return;
    }
    let cancelled = false;
    asset
      .getUri()
      .then((resolved) => {
        uriCache.set(asset.id, resolved);
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
      disabled={picking || dimmed}
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
      {picking ? (
        <View style={styles.pickingOverlay}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : null}
      {dimmed ? <View style={styles.dimOverlay} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { gap: GUTTER },
  content: { gap: GUTTER },
  image: { width: '100%', height: '100%' },
  pickingOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dimOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
});

export default PhotoLibraryGrid;
