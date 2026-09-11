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
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { useTheme } from '../lib/theme';

const COLUMNS = 4;
const PAGE_SIZE = 60;
const GUTTER = 1;

/**
 * A grid cell only ever needs to show a photo at ~90pt. asset.getUri()
 * hands back the *original* file, though -- a real camera roll is full of
 * 12-48MP HEICs, and asking expo-image to decode one per cell for every
 * photo scrolled past is what "scrolling back a lot feels like it's trying
 * to render every photo and crashes" actually was: dozens of full-resolution
 * decodes resident at once under a fast fling, with no ceiling that scales
 * with library size. Instagram's own picker (and every other one) never
 * touches the original for a grid tile -- it asks the OS for a thumbnail.
 * expo-media-library's SDK 57 rewrite doesn't expose that (no
 * getThumbnailUri, no targetSize), so this generates the equivalent once via
 * ImageManipulator: a tiny on-disk JPEG, decoded once, from then on serving
 * every re-view of that photo (scrolling back up, or opening the composer
 * again this session) at a bounded ~2 KB-ish cost instead of a full decode.
 *
 * Module-level, not per-grid-instance -- the id -> thumbnail-uri mapping is
 * stable for the life of the app, so there's no reason to lose it when this
 * screen unmounts and regenerate it next time the composer opens.
 */
const uriCache = new Map<string, string>();

/**
 * ~2-3x a grid cell's on-screen size on the densest phones -- plenty sharp
 * for a ~90pt tile, and small enough that decoding it is effectively free.
 * A single-axis resize (not {width, height} together, which would stretch a
 * non-square photo instead of preserving its aspect ratio -- see the same
 * convention in lib/bake.ts) means a landscape photo's untouched axis can
 * land a bit under this, which is fine: contentFit="cover" is already
 * cropping the result into a square cell either way.
 */
const THUMB_EDGE = 320;

/**
 * asset.getUri() sets isNetworkAccessAllowed = true on iOS -- for an older
 * photo that's been iCloud-optimized off the device (the default once local
 * storage fills up, so exactly the photos a fast scroll-back goes looking
 * for), that's a real network download, not a fast local lookup, before the
 * resize/encode below even starts.
 *
 * A fast fling mounts and unmounts many cells in quick succession. Without a
 * cap, every one of them fired off its own getUri()+manipulate() chain
 * immediately, and unmounting a cell doesn't cancel the native work already
 * in flight -- so scrolling quickly could queue up dozens of concurrent
 * iCloud downloads for photos already scrolled past, which then sat ahead of
 * (and starved) the request for whatever's actually on screen now. That's
 * "scroll fast and older photos never render": not a hang, a backlog with no
 * fairness to what's currently visible.
 *
 * Fix: cap how many of these run at once, and -- since a cell that's been
 * unmounted before its turn even comes up is a photo nobody's looking at
 * anymore -- drop still-queued work for it instead of starting it.
 */
const MAX_CONCURRENT_THUMBNAILS = 3;
let activeThumbnails = 0;
const thumbnailQueue: Array<{
  asset: Asset;
  cancelled: { value: boolean };
  resolve: (uri: string) => void;
  reject: (e: unknown) => void;
}> = [];

function drainThumbnailQueue() {
  while (activeThumbnails < MAX_CONCURRENT_THUMBNAILS && thumbnailQueue.length > 0) {
    // LIFO, not FIFO: the most recently requested cell is the one most
    // likely to still be on screen once a fling settles, so it should jump
    // ahead of requests queued earlier in the same fling rather than wait
    // behind a backlog of cells that have probably scrolled past by now.
    const next = thumbnailQueue.pop()!;
    if (next.cancelled.value) continue; // abandoned before its turn -- skip entirely
    activeThumbnails++;
    generateThumbnail(next.asset)
      .then(next.resolve, next.reject)
      .finally(() => {
        activeThumbnails--;
        drainThumbnailQueue();
      });
  }
}

async function generateThumbnail(asset: Asset): Promise<string> {
  const original = await asset.getUri();
  const rendered = await ImageManipulator.manipulate(original)
    .resize({ width: THUMB_EDGE })
    .renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.6 });
  return saved.uri;
}

function resolveGridThumbnail(asset: Asset, cancelled: { value: boolean }): Promise<string> {
  const cached = uriCache.get(asset.id);
  if (cached) return Promise.resolve(cached);
  return new Promise<string>((resolve, reject) => {
    thumbnailQueue.push({
      asset,
      cancelled,
      resolve: (uri) => {
        uriCache.set(asset.id, uri);
        resolve(uri);
      },
      reject,
    });
    drainThumbnailQueue();
  });
}

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
      maxToRenderPerBatch={12}
      updateCellsBatchingPeriod={50}
      windowSize={5}
      removeClippedSubviews
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
    const cancelled = { value: false };
    resolveGridThumbnail(asset, cancelled)
      .then((resolved) => {
        if (!cancelled.value) setUri(resolved);
      })
      .catch(() => undefined);
    return () => {
      cancelled.value = true;
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
