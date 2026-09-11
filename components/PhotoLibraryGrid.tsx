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
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ListRenderItemInfo, StyleProp, ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { Album, Asset, AssetField, MediaType, Query } from 'expo-media-library';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import Feather from '@expo/vector-icons/Feather';

import { hairlineWidth, spacing, useTheme } from '../lib/theme';

/**
 * What the grid is currently listing. 'recents' and 'favorites' are both
 * plain field predicates on Query (AssetField.IS_FAVORITE, no album
 * involved) rather than PHAssetCollection smart albums -- expo-media-
 * library's Album API only surfaces PHAssetCollectionType.album (regular,
 * user-created albums); it never fetches .smartAlbum collections, so there
 * is no Album object for Favorites/Recents/Camera Roll to filter by even
 * though those are exactly what Instagram's own picker offers first. Recents
 * needs no filter at all -- it's just every photo, newest first, which is
 * already this grid's default query.
 */
type PhotoSource =
  | { kind: 'recents' }
  | { kind: 'favorites' }
  | { kind: 'album'; id: string; title: string };

function sourceLabel(source: PhotoSource): string {
  switch (source.kind) {
    case 'recents':
      return 'Recents';
    case 'favorites':
      return 'Favorites';
    case 'album':
      return source.title;
  }
}

function sameSource(a: PhotoSource, b: PhotoSource): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'album' && b.kind === 'album' ? a.id === b.id : true;
}

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
  const { colors, typography } = useTheme();
  const [source, setSource] = useState<PhotoSource>({ kind: 'recents' });
  const [assets, setAssets] = useState<Asset[]>([]);
  const [page, setPage] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(true);
  const [loading, setLoading] = useState(true);
  // The one cell currently resolving getInfo() after a tap -- shown with a
  // spinner in place of the thumbnail, and taps elsewhere are ignored while
  // it's set so a second tap can't race the first into the adjust step.
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // null = not fetched yet (lazy -- most composer opens never touch the
  // switcher, so there's no reason to pay Album.getAll() + a getTitle() per
  // album on every single one).
  const [albumOptions, setAlbumOptions] = useState<{ id: string; title: string }[] | null>(null);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const loadingRef = useRef(false);
  // Bumped on every source switch. loadPage captures the version it was
  // called with and drops its results if the source has moved on by the time
  // they arrive -- otherwise a slow in-flight load for the *previous* source
  // (e.g. a big album, mid-network-bound iCloud fetches) could land after the
  // switch and get appended onto the new source's results. Also subsumes the
  // old dev-mode-double-invoke guard: StrictMode's extra mount just bumps the
  // version again, and the first call's results get discarded the same way.
  const sourceVersionRef = useRef(0);

  const loadPage = useCallback(
    async (pageToLoad: number) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      const version = sourceVersionRef.current;
      try {
        let query = new Query().eq(AssetField.MEDIA_TYPE, MediaType.IMAGE);
        if (source.kind === 'favorites') {
          query = query.eq(AssetField.IS_FAVORITE, true);
        } else if (source.kind === 'album') {
          query = query.album(new Album(source.id));
        }
        const results = await query
          .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
          .limit(PAGE_SIZE)
          .offset(pageToLoad * PAGE_SIZE)
          .exe();
        if (version !== sourceVersionRef.current) return;
        setAssets((prev) => (pageToLoad === 0 ? results : [...prev, ...results]));
        setHasNextPage(results.length === PAGE_SIZE);
        setPage(pageToLoad);
      } finally {
        if (version === sourceVersionRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [source]
  );

  useEffect(() => {
    sourceVersionRef.current += 1;
    loadingRef.current = false; // abandon any in-flight load for the previous source
    setAssets([]);
    setHasNextPage(true);
    setPage(0);
    setLoading(true);
    void loadPage(0);
  }, [loadPage]);

  const onEndReached = useCallback(() => {
    if (hasNextPage) void loadPage(page + 1);
  }, [hasNextPage, page, loadPage]);

  const openPicker = useCallback(() => {
    setPickerOpen(true);
    if (albumOptions !== null || albumsLoading) return;
    setAlbumsLoading(true);
    Album.getAll()
      .then((albums) => Promise.all(albums.map(async (a) => ({ id: a.id, title: await a.getTitle() }))))
      .then((withTitles) => {
        withTitles.sort((a, b) => a.title.localeCompare(b.title));
        setAlbumOptions(withTitles);
      })
      .catch(() => setAlbumOptions([]))
      .finally(() => setAlbumsLoading(false));
  }, [albumOptions, albumsLoading]);

  const selectSource = useCallback(
    (next: PhotoSource) => {
      setPickerOpen(false);
      if (!sameSource(source, next)) setSource(next);
    },
    [source]
  );

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
    <View style={[{ backgroundColor: colors.surface }, style]}>
      <Pressable
        onPress={openPicker}
        style={[styles.sourceRow, { borderBottomColor: colors.border }]}
        hitSlop={8}
      >
        <Text style={[typography.bodyStrong, { color: colors.text }]}>{sourceLabel(source)}</Text>
        <Feather
          name="chevron-down"
          size={16}
          color={colors.text}
          style={styles.sourceChevron}
        />
      </Pressable>

      <FlatList
        data={assets}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        numColumns={COLUMNS}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.content}
        style={[styles.list, { backgroundColor: colors.surface }]}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.6}
        showsVerticalScrollIndicator={false}
        getItemLayout={getItemLayout}
        initialNumToRender={24}
        maxToRenderPerBatch={12}
        updateCellsBatchingPeriod={50}
        windowSize={5}
        removeClippedSubviews
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyState}>
              <Text style={[typography.body, { color: colors.textSecondary }]}>
                {source.kind === 'favorites' ? 'No favorites yet' : 'No photos here'}
              </Text>
            </View>
          ) : null
        }
      />

      <Modal
        visible={pickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable
          style={[styles.backdrop, { backgroundColor: colors.scrim }]}
          onPress={() => setPickerOpen(false)}
          accessibilityLabel="Close"
        />
        <View style={[styles.sheet, { backgroundColor: colors.surface }]}>
          <ScrollView bounces={false}>
            <SourceOption
              label="Recents"
              selected={source.kind === 'recents'}
              onPress={() => selectSource({ kind: 'recents' })}
            />
            <SourceOption
              label="Favorites"
              selected={source.kind === 'favorites'}
              onPress={() => selectSource({ kind: 'favorites' })}
            />
            {albumsLoading ? (
              <ActivityIndicator style={styles.albumsLoading} color={colors.textSecondary} />
            ) : null}
            {(albumOptions ?? []).map((album) => (
              <SourceOption
                key={album.id}
                label={album.title}
                selected={source.kind === 'album' && source.id === album.id}
                onPress={() => selectSource({ kind: 'album', id: album.id, title: album.title })}
              />
            ))}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

/** One row in the source-switcher sheet -- a label, and a checkmark on
 * whatever's currently selected, matching the OS's own picker convention. */
function SourceOption({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors, typography } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={[styles.sourceOption, { borderBottomColor: colors.border }]}
    >
      <Text style={[typography.body, { color: colors.text }]}>{label}</Text>
      {selected ? <Feather name="check" size={18} color={colors.accent} /> : null}
    </Pressable>
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
  list: { flex: 1 },
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
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: hairlineWidth,
  },
  sourceChevron: {
    marginLeft: spacing.xs,
  },
  emptyState: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '70%',
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
  },
  sourceOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: hairlineWidth,
  },
  albumsLoading: {
    paddingVertical: spacing.lg,
  },
});

export default PhotoLibraryGrid;
