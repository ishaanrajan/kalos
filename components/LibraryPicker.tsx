/**
 * The composer's photo picker: a live crop preview of whatever's selected on
 * top, the camera roll as a grid underneath, an album switcher between them.
 * One screen, the way Instagram's own composer works today -- tapping a
 * thumbnail doesn't navigate anywhere, it just swaps what the preview is
 * showing, so trying five photos costs five taps instead of five round trips
 * through a separate crop screen.
 *
 * ---------------------------------------------------------------------------
 * Why this reads the library through `expo-media-library/legacy`
 * ---------------------------------------------------------------------------
 *
 * SDK 57's class-based API exposes an asset's uri only through `getUri()`,
 * an async getter that hands back the *original* file -- and on iOS sets
 * `isNetworkAccessAllowed`, so for an iCloud-optimized photo that call is a
 * full-size download. There is no thumbnail API on it at all. A grid built on
 * that has to manufacture its own thumbnails, which is what this file used to
 * do: one ImageManipulator decode + resize + JPEG write per tile, three at a
 * time. That is why photos didn't render during a fast scroll. Every tile
 * queued a full-resolution decode of a 12-48MP HEIC, the queue was three
 * wide, and a fling could enqueue a hundred tiles in a second. Successive
 * fixes -- an LRU-ish cache, a concurrency cap, LIFO ordering, cancellation
 * on unmount -- were all shaving the constant factor off work that should
 * never have been happening on this side of the bridge at all.
 *
 * The legacy API returns `uri` *synchronously* on the asset: `ph://<id>` on
 * iOS, `file://` on Android. expo-image has a first-class loader for both.
 * On iOS the `ph://` loader asks PHImageManager for the asset at the target
 * view's own size (it reads the container frame and screen scale out of the
 * image request context), which is the OS's own thumbnail path -- the same
 * one Photos.app and Instagram use -- and it cancels the PHImageRequest when
 * a cell recycles, so a fling abandons work instead of queueing it. On
 * Android, Glide downsamples to the view. Either way the grid does no image
 * work in JS whatsoever: no decode, no resize, no temp files, no queue, no
 * cache of our own, and no ceiling that has to scale with library size.
 *
 * The legacy API also has what the new one is missing for a picker: smart
 * albums (Favorites, Screenshots, Selfies...) via
 * `getAlbumsAsync({ includeSmartAlbums: true })`, cursor pagination, and
 * width/height on the asset without a second call.
 *
 * The tradeoff is that a `ph://` uri isn't a file, so it can't be handed to
 * ImageManipulator or Skia. That's resolved once, for the one photo the user
 * actually commits to, in `handleNext` below.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { ListRenderItemInfo } from 'react-native';
import Animated, {
  clamp,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library/legacy';
import Feather from '@expo/vector-icons/Feather';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CropAdjust } from './CropAdjust';
import type { CropAdjustHandle } from './CropAdjust';
import { displayAspectRatio } from './PostCard';
import { hairlineWidth, spacing, radius, useTheme } from '../lib/theme';
import type { CropRect, ImageSize } from '../lib/types';

const COLUMNS = 4;
const GUTTER = 1.5;
/**
 * Large, because a page is now pure metadata -- ids, uris and dimensions --
 * with no image work attached to it. The old 60 existed to keep the thumbnail
 * queue from being buried; nothing is queued any more, so the only thing page
 * size controls is how often a scroll has to stop and wait.
 */
const PAGE_SIZE = 120;

/**
 * How much of the screen the preview is allowed to take. A square preview
 * (`width` tall) is the shape Instagram uses, but on a short phone that
 * leaves barely a row and a half of grid, so it gives way on height first.
 */
const PREVIEW_HEIGHT_FRACTION = 0.46;

/**
 * What the grid is listing. `all` is every photo, newest first, with no album
 * predicate -- iOS's own "Recents" smart album is the same set of photos, and
 * is filtered back out of the album list below so it doesn't appear twice.
 */
type PhotoSource = { kind: 'all' } | { kind: 'album'; id: string; title: string };

const ALL_PHOTOS_LABEL = 'Recents';

function sourceLabel(source: PhotoSource): string {
  return source.kind === 'all' ? ALL_PHOTOS_LABEL : source.title;
}

function sameSource(a: PhotoSource, b: PhotoSource): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'album' && b.kind === 'album' ? a.id === b.id : true;
}

/**
 * The photo under the crop frame. `natural` starts as the library's own
 * metadata and is corrected from what expo-image actually decoded (see
 * CropAdjust's `onImageLoad`) -- its *ratio* is what shapes the frame, and
 * Android's MediaStore reports pre-rotation dimensions for EXIF-rotated
 * photos, which would otherwise frame a portrait shot as a landscape one.
 */
type Selection = { asset: MediaLibrary.Asset; natural: ImageSize };

/** Instagram's two framings: the photo's own shape, or a hard square. */
type AspectMode = 'original' | 'square';

export interface LibraryPickerProps {
  /** Backing out of posting entirely. */
  onCancel: () => void;
  /**
   * False during a forced first post, where Cancel can't actually go
   * anywhere (the onboarding redirect brings the composer straight back) --
   * it used to flash the feed and reload the grid for a button that did
   * nothing. Defaults to true.
   */
  canCancel?: boolean;
  /** The camera button in the toolbar -- the picker itself never opens it. */
  onOpenCamera: () => void;
  /**
   * A photo, resolved to a real on-disk file, plus the region the user
   * framed in that file's own pixel space, plus which asset it was (so the
   * composer can tell a re-pick of the same photo from a new one). Awaited:
   * the "Next" button stays in its spinner until this settles, so a slow
   * prepare can't be double-fired.
   */
  onNext: (pick: {
    uri: string;
    natural: ImageSize;
    crop: CropRect;
    assetId: string;
  }) => Promise<void> | void;
}

export function LibraryPicker({
  onCancel,
  canCancel = true,
  onOpenCamera,
  onNext,
}: LibraryPickerProps) {
  const { colors, typography } = useTheme();
  const { width, height } = useWindowDimensions();

  const [source, setSource] = useState<PhotoSource>({ kind: 'all' });
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasNextPage, setHasNextPage] = useState(true);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [aspectMode, setAspectMode] = useState<AspectMode>('original');
  const [advancing, setAdvancing] = useState(false);
  const [limitedAccess, setLimitedAccess] = useState(false);

  const [albumsOpen, setAlbumsOpen] = useState(false);
  // null = not fetched yet. Lazy: most composer opens never touch the
  // switcher, and enumerating albums costs a cover-photo query apiece.
  const [albums, setAlbums] = useState<AlbumEntry[] | null>(null);
  const [albumsLoading, setAlbumsLoading] = useState(false);

  const cropRef = useRef<CropAdjustHandle>(null);
  const listRef = useRef<FlatList<MediaLibrary.Asset>>(null);
  const loadingRef = useRef(false);
  /**
   * Bumped on every source switch. A load captures the version it started
   * with and throws its results away if the source has moved on -- otherwise
   * a slow query for the previous album lands after the switch and gets
   * appended to the new one's results. Also subsumes the dev-mode
   * double-invoke guard: StrictMode's extra mount just bumps it again.
   */
  const versionRef = useRef(0);

  const loadPage = useCallback(
    async (after: string | undefined) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      const version = versionRef.current;
      try {
        const page = await MediaLibrary.getAssetsAsync({
          first: PAGE_SIZE,
          after,
          album: source.kind === 'album' ? source.id : undefined,
          mediaType: [MediaLibrary.MediaType.photo],
          sortBy: [MediaLibrary.SortBy.creationTime],
        });
        if (version !== versionRef.current) return;
        setAssets((prev) => (after ? [...prev, ...page.assets] : page.assets));
        setCursor(page.endCursor);
        setHasNextPage(page.hasNextPage);
      } catch {
        if (version === versionRef.current) setHasNextPage(false);
      } finally {
        if (version === versionRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [source]
  );

  // Reload from scratch whenever the source changes.
  useEffect(() => {
    versionRef.current += 1;
    loadingRef.current = false; // abandon any in-flight load for the old source
    setAssets([]);
    setCursor(undefined);
    setHasNextPage(true);
    setLoading(true);
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    void loadPage(undefined);
  }, [loadPage]);

  // Instagram opens with the most recent photo already framed, so the screen
  // is never a dead grid waiting to be told what to do. Only ever fills an
  // empty selection -- switching albums keeps whatever's already framed.
  useEffect(() => {
    if (selection || assets.length === 0) return;
    const first = assets[0];
    setSelection({ asset: first, natural: { width: first.width, height: first.height } });
  }, [assets, selection]);

  // iOS 14+/Android 14+ can grant access to a hand-picked subset of the
  // library. Without saying so, that shows up as a camera roll that's
  // mysteriously missing almost everything and no way to fix it from here.
  useEffect(() => {
    let alive = true;
    MediaLibrary.getPermissionsAsync()
      .then((p) => {
        if (alive) setLimitedAccess(p.accessPrivileges === 'limited');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // A photo taken from the camera button, or added through the limited-access
  // picker, should appear without having to leave and come back.
  useEffect(() => {
    const subscription = MediaLibrary.addListener(() => {
      versionRef.current += 1;
      loadingRef.current = false;
      setCursor(undefined);
      setHasNextPage(true);
      void loadPage(undefined);
    });
    return () => subscription.remove();
  }, [loadPage]);

  const onEndReached = useCallback(() => {
    if (hasNextPage && !loadingRef.current) void loadPage(cursor);
  }, [hasNextPage, cursor, loadPage]);

  const openAlbums = useCallback(() => {
    setAlbumsOpen(true);
    if (albums !== null || albumsLoading) return;
    setAlbumsLoading(true);
    loadAlbums()
      .then(setAlbums)
      .catch(() => setAlbums([]))
      .finally(() => setAlbumsLoading(false));
  }, [albums, albumsLoading]);

  const selectSource = useCallback(
    (next: PhotoSource) => {
      setAlbumsOpen(false);
      if (!sameSource(source, next)) setSource(next);
    },
    [source]
  );

  // Read by handleSelect, which has to keep a stable identity (it's memoized
  // into every grid cell) and so can't close over `advancing` as state.
  const advancingRef = useRef(false);

  // A tap deep in the grid, with the pane scrolled fully out of view (see
  // paneWrapStyle below), used to swap the framed photo with nothing on
  // screen to show it -- the only way to see it was to scroll back up
  // yourself. handleSelect below pops the pane open regardless of scroll
  // depth to show it for you, but deliberately *not* by moving the grid's
  // own scroll position (an earlier version called scrollToOffset(0) here) --
  // that's a real cost, not a free peek: it leaves you back at the top of
  // however many hundred photos you'd already scrolled past, so getting back
  // to where you were costs the same scroll a second time.
  //
  // This instead overrides paneWrapStyle's height independently of scrollY,
  // and leaves it there -- frozen open -- until the grid is actually
  // touched again (onScrollBeginDrag below), not on a timer. An earlier
  // version eased it back closed a second or so after opening on its own,
  // which on a deep scroll position reads as the exact thing this is meant
  // to avoid: it pops open, then pops itself shut again with nobody asking
  // it to. Scrolling by hand is what hands control back to scrollY, and
  // that resumes exactly where the real, never-touched offset already was.
  const revealBoost = useSharedValue(0);

  const handleSelect = useCallback((asset: MediaLibrary.Asset) => {
    // Tapping another photo while "Next" is mid-flight would swap the framed
    // photo out from under a prepare that's already reading the old one.
    if (advancingRef.current) return;
    setSelection({ asset, natural: { width: asset.width, height: asset.height } });
    revealBoost.value = withTiming(1, { duration: 160 });
  }, []);

  // The moment the grid is actually dragged again -- not a timer -- is what
  // un-freezes the pane, easing control back to the plain scrollY-driven
  // collapse (see paneWrapStyle) from wherever the real offset already is.
  const onScrollBeginDrag = useCallback(() => {
    revealBoost.value = withTiming(0, { duration: 200 });
  }, []);

  /** Corrects a ratio the library's metadata got wrong (see Selection). */
  const handleImageLoad = useCallback((size: ImageSize) => {
    if (size.width <= 0 || size.height <= 0) return;
    setSelection((prev) => {
      if (!prev) return prev;
      const was = prev.natural.width / prev.natural.height;
      const is = size.width / size.height;
      // Only a genuine disagreement, not a rounded pixel: this remounts the
      // crop surface, and doing that on every load would throw away a zoom
      // the user had already set.
      if (Math.abs(was - is) < 0.01) return prev;
      return { asset: prev.asset, natural: size };
    });
  }, []);

  const handleNext = useCallback(async () => {
    // Grabbed before the await, not after: the gesture state lives on this
    // particular CropAdjust instance, and anything that remounts it while the
    // asset info is resolving (an aspect toggle, a ratio correction) would
    // leave cropRef pointing at a fresh instance sitting at its default zoom.
    // The handle captured here still holds what the user actually framed.
    const cropHandle = cropRef.current;
    if (!selection || !cropHandle || advancingRef.current) return;
    advancingRef.current = true;
    setAdvancing(true);
    try {
      // The one place the full-size file is resolved. `localUri` is a real
      // `file://` path that ImageManipulator can open, and its width/height
      // are the original's true pixel count -- which is what the crop has to
      // be expressed against, since the preview was showing a screen-sized
      // copy PhotoKit rendered on the fly. For an iCloud-optimized photo this
      // is the download, which is why the button holds a spinner.
      const info = await MediaLibrary.getAssetInfoAsync(selection.asset);
      const uri = info.localUri ?? info.uri;
      const natural = { width: info.width, height: info.height };
      await onNext({ uri, natural, crop: cropHandle.getCrop(natural), assetId: selection.asset.id });
    } catch (e) {
      // getAssetInfoAsync is the iCloud download for an optimized photo, so
      // the likeliest cause is no connection -- say so rather than leaving a
      // bare native error message as the whole explanation.
      Alert.alert(
        'Could not use that photo',
        [
          e instanceof Error ? e.message : null,
          'If it’s stored in iCloud, check your connection and try again.',
        ]
          .filter(Boolean)
          .join('\n\n')
      );
    } finally {
      advancingRef.current = false;
      setAdvancing(false);
    }
  }, [selection, onNext]);

  // The preview's box. Width-wide and square where there's room, giving way
  // on height on a short screen so the grid always keeps a usable slice.
  const pane = useMemo(
    () => ({ width, height: Math.round(Math.min(width, height * PREVIEW_HEIGHT_FRACTION)) }),
    [width, height]
  );

  // Instagram's own composer: scroll the grid up and the preview collapses
  // out of the way one-to-one with the drag, so a determined scroll gets you
  // the whole screen of photos; scroll back down and it's there again. The
  // *inner* box (below) stays pane.height always -- only this outer wrapper's
  // height shrinks, clipped by its own overflow:hidden -- so CropAdjust never
  // reflows or remounts over the course of a drag, just gets progressively
  // clipped from the bottom. scrollY is clamped to [0, pane.height] up front
  // so an iOS rubber-band overscroll past either end can't overshoot it.
  // Clamped *here*, at the write, not just when it's read below. scrollY
  // otherwise keeps climbing for as long as a scroll continues, however far
  // past pane.height that goes -- and since paneWrapStyle depends on it, an
  // unclamped value means that layout-affecting style keeps recomputing and
  // recommitting every single frame for the rest of a long scroll, not just
  // the brief bit where the preview is actually collapsing. Pinning the
  // value here means it stops changing the moment the preview is fully
  // collapsed, and a shared value that isn't changing triggers nothing.
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = clamp(e.contentOffset.y, 0, pane.height);
  });
  // revealBoost (see handleSelect above) temporarily discounts how much
  // scrollY is allowed to collapse the pane by, independently of the actual
  // scroll position -- at boost 1 the pane is fully open no matter how far
  // scrolled down the grid genuinely is; at 0 (its resting value the rest of
  // the time) this is exactly the plain `pane.height - scrollY.value` it's
  // always been.
  const paneWrapStyle = useAnimatedStyle(() => ({
    height: pane.height - scrollY.value * (1 - revealBoost.value),
  }));

  const naturalRatio = selection
    ? displayAspectRatio(selection.natural.width, selection.natural.height)
    : 1;
  const frame = useMemo(
    () => fitFrame(aspectMode === 'square' ? 1 : naturalRatio, pane),
    [aspectMode, naturalRatio, pane]
  );
  // Nothing to toggle to on a photo that's already square.
  const canToggleAspect = Math.abs(naturalRatio - 1) > 0.01;

  const cellSize = (width - GUTTER * (COLUMNS - 1)) / COLUMNS;

  // Fixed-size cells in fixed-height rows. Telling FlatList the geometry up
  // front means a fling never has to measure a row before it can scroll to it.
  const getItemLayout = useCallback(
    (_data: ArrayLike<MediaLibrary.Asset> | null | undefined, index: number) => {
      const length = cellSize + GUTTER;
      return { length, offset: length * Math.floor(index / COLUMNS), index };
    },
    [cellSize]
  );

  const selectedId = selection?.asset.id ?? null;

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<MediaLibrary.Asset>) => (
      <GridCell
        asset={item}
        size={cellSize}
        selected={item.id === selectedId}
        placeholderColor={colors.imagePlaceholder}
        onPress={handleSelect}
      />
    ),
    [cellSize, selectedId, colors.imagePlaceholder, handleSelect]
  );

  const keyExtractor = useCallback((item: MediaLibrary.Asset) => item.id, []);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        {canCancel ? (
          <Pressable
            onPress={onCancel}
            hitSlop={12}
            disabled={advancing}
            accessibilityRole="button"
            accessibilityState={{ disabled: advancing }}
          >
            <Text style={[typography.body, { color: colors.text }, advancing && styles.disabled]}>
              Cancel
            </Text>
          </Pressable>
        ) : (
          <View style={styles.headerSpacer} />
        )}
        <Text style={[styles.title, { color: colors.text }]}>New post</Text>
        <Pressable
          onPress={handleNext}
          hitSlop={12}
          disabled={advancing || !selection}
          accessibilityRole="button"
          accessibilityLabel="Next"
        >
          {advancing ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text
              style={[
                typography.bodyStrong,
                { color: colors.accent },
                !selection && styles.disabled,
              ]}
            >
              Next
            </Text>
          )}
        </Pressable>
      </View>

      <Animated.View style={[styles.paneWrap, { width: pane.width }, paneWrapStyle]}>
        <View style={[styles.pane, { width: pane.width, height: pane.height }]}>
          {selection ? (
            <>
              <CropAdjust
                // Remounting is how a new photo (or a new framing) gets a clean
                // zoom/pan. The shared values that hold the gesture state are
                // seeded once, so without this the second photo you tapped
                // would inherit the first one's zoom.
                key={`${selection.asset.id}:${aspectMode}:${frame.width}x${frame.height}`}
                ref={cropRef}
                uri={selection.asset.uri}
                natural={selection.natural}
                frame={frame}
                onImageLoad={handleImageLoad}
              />
              {canToggleAspect ? (
                <Pressable
                  onPress={() => setAspectMode((m) => (m === 'square' ? 'original' : 'square'))}
                  style={styles.aspectButton}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={
                    aspectMode === 'square' ? 'Use original shape' : 'Crop to square'
                  }
                >
                  <Ionicons
                    name={aspectMode === 'square' ? 'scan-outline' : 'square-outline'}
                    size={15}
                    color="#fff"
                  />
                  <Text style={styles.aspectLabel}>
                    {aspectMode === 'square' ? 'Original' : 'Square'}
                  </Text>
                </Pressable>
              ) : null}
            </>
          ) : null}
        </View>
      </Animated.View>

      <View style={[styles.toolbar, { borderBottomColor: colors.border }]}>
        <Pressable onPress={openAlbums} hitSlop={8} style={styles.sourceButton}>
          <Text style={[typography.bodyStrong, { color: colors.text }]} numberOfLines={1}>
            {sourceLabel(source)}
          </Text>
          <Feather name="chevron-down" size={15} color={colors.text} style={styles.sourceChevron} />
        </Pressable>
        <Pressable
          onPress={onOpenCamera}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Take photo"
          style={[styles.cameraButton, { backgroundColor: colors.surfaceAlt }]}
        >
          <Ionicons name="camera-outline" size={19} color={colors.text} />
        </Pressable>
      </View>

      {limitedAccess ? (
        <Pressable
          onPress={() => {
            MediaLibrary.presentPermissionsPickerAsync().catch(() => undefined);
          }}
          style={[styles.limitedBanner, { backgroundColor: colors.surfaceAlt }]}
        >
          <Text style={[typography.caption, { color: colors.textSecondary }]} numberOfLines={1}>
            Kalos can only see some of your photos
          </Text>
          <Text style={[typography.metaStrong, { color: colors.accent }]}>Manage</Text>
        </Pressable>
      ) : null}

      <Animated.FlatList
        ref={listRef}
        data={assets}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        numColumns={COLUMNS}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.content}
        style={styles.list}
        onScroll={onScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        scrollEventThrottle={16}
        onEndReached={onEndReached}
        onEndReachedThreshold={1.5}
        showsVerticalScrollIndicator={false}
        getItemLayout={getItemLayout}
        initialNumToRender={COLUMNS * 8}
        // Reverted: narrowing this to 5/COLUMNS*3 (to shrink the post-fling
        // image-decode burst) instead produced a worse failure -- a fast
        // fling can outrun a narrow window's pre-rendered content entirely,
        // landing on a patch of grid nothing has rendered yet, which shows
        // as a blank white screen rather than a stutter. Back to the
        // original values; this was a guess made without being able to
        // profile the actual device, and it was the wrong one.
        maxToRenderPerBatch={COLUMNS * 6}
        updateCellsBatchingPeriod={30}
        windowSize={9}
        // Android only. On iOS this has a long history of clipping cells that
        // are still on screen, and the reason it was here -- keeping a lid on
        // how many images were resident -- no longer applies now that nothing
        // holds a full-resolution decode.
        removeClippedSubviews={Platform.OS === 'android'}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.listSpinner} color={colors.textSecondary} />
          ) : (
            <View style={styles.emptyState}>
              <Text style={[typography.body, { color: colors.textSecondary }]}>No photos here</Text>
            </View>
          )
        }
      />

      <Modal
        visible={albumsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setAlbumsOpen(false)}
      >
        <Pressable
          style={[styles.backdrop, { backgroundColor: colors.scrim }]}
          onPress={() => setAlbumsOpen(false)}
          accessibilityLabel="Close"
        />
        <View style={[styles.sheet, { backgroundColor: colors.surface }]}>
          <View style={[styles.grabber, { backgroundColor: colors.border }]} />
          <ScrollView bounces={false} contentContainerStyle={styles.sheetContent}>
            <AlbumRow
              title={ALL_PHOTOS_LABEL}
              selected={source.kind === 'all'}
              onPress={() => selectSource({ kind: 'all' })}
            />
            {albums?.map((album) => (
              <AlbumRow
                key={album.id}
                title={album.title}
                count={album.count}
                coverUri={album.coverUri}
                selected={source.kind === 'album' && source.id === album.id}
                onPress={() => selectSource({ kind: 'album', id: album.id, title: album.title })}
              />
            ))}
            {albumsLoading ? (
              <ActivityIndicator style={styles.albumsSpinner} color={colors.textSecondary} />
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Grid cell
// ---------------------------------------------------------------------------

/**
 * A tile is now a plain `<Image>` over a uri the asset already carried. All
 * of the machinery this used to need -- the async uri getter, the module-
 * level thumbnail cache, the concurrency-capped queue, the per-cell
 * cancellation token -- went away with the thumbnails it was managing.
 *
 * Memoized on identity, with a `size` and `selected` that only change when
 * they genuinely do, so a fling re-renders nothing that isn't new.
 */
const GridCell = memo(function GridCell({
  asset,
  size,
  selected,
  placeholderColor,
  onPress,
}: {
  asset: MediaLibrary.Asset;
  size: number;
  selected: boolean;
  placeholderColor: string;
  onPress: (asset: MediaLibrary.Asset) => void;
}) {
  // Normally just `asset.uri`. See the fallback below for when it isn't.
  const [uri, setUri] = useState(asset.uri);
  useEffect(() => setUri(asset.uri), [asset.uri]);

  return (
    <Pressable
      onPress={() => onPress(asset)}
      accessibilityRole="imagebutton"
      accessibilityLabel="Photo"
      accessibilityState={{ selected }}
      style={{ width: size, height: size, backgroundColor: placeholderColor }}
    >
      <Image
        source={uri}
        style={styles.cellImage}
        contentFit="cover"
        // No cross-fade. A tile appearing under your thumb mid-scroll should
        // just be there, the way it is in Photos.app -- a fade reads as lag.
        transition={0}
        cachePolicy="memory-disk"
        recyclingKey={asset.id}
        accessible={false}
        onError={() => {
          void resolveFallbackUri(asset).then((resolved) => {
            if (resolved) setUri(resolved);
          });
        }}
      />
      {selected ? (
        <>
          <View style={styles.selectedDim} />
          <View style={styles.selectedRing} />
        </>
      ) : null}
    </Pressable>
  );
});

/**
 * Last resort for a tile whose uri the image loader couldn't handle.
 *
 * The whole design rests on expo-image rendering the library's own uri
 * directly -- `ph://` through its PhotoKit loader on iOS, `file://` through
 * Glide on Android. If that ever isn't true (an OS release changing what
 * PhotoKit accepts, a device where the asset has no readable backing file),
 * the failure mode without this is the worst possible one for this screen:
 * a grid of empty squares, which is exactly the complaint this rewrite
 * exists to fix. So a tile that errors resolves a plain file path once and
 * tries again.
 *
 * `shouldDownloadFromNetwork: false` deliberately: this must stay a cheap
 * local metadata read. If the primary path were broken every visible tile
 * would land here at once, and letting that turn into a hundred concurrent
 * iCloud downloads would recreate the original bug rather than soften it --
 * better to leave an iCloud-only photo blank than to wedge the whole grid.
 *
 * Results are shared across cells so scrolling a photo back into view is a
 * cache read, and one bad asset is only ever resolved once.
 */
const fallbackUris = new Map<string, Promise<string | null>>();

function resolveFallbackUri(asset: MediaLibrary.Asset): Promise<string | null> {
  const existing = fallbackUris.get(asset.id);
  if (existing) return existing;
  const pending = MediaLibrary.getAssetInfoAsync(asset, { shouldDownloadFromNetwork: false })
    .then((info) => (info.localUri && info.localUri !== asset.uri ? info.localUri : null))
    .catch(() => null);
  fallbackUris.set(asset.id, pending);
  return pending;
}

// ---------------------------------------------------------------------------
// Album switcher
// ---------------------------------------------------------------------------

type AlbumEntry = { id: string; title: string; count: number; coverUri?: string };

/**
 * Albums with their most recent photo as a cover, the way every OS picker
 * presents them -- a bare list of names gives you no way to recognise the
 * album you meant.
 *
 * Anything empty is dropped (a video-only album has no photos to show), as is
 * the smart album that mirrors the whole library, which would otherwise sit
 * directly under the "Recents" entry that already means exactly that. The
 * title match is English-only, which is what the rest of this app's copy is;
 * in another locale the worst case is one redundant row.
 */
async function loadAlbums(): Promise<AlbumEntry[]> {
  const found = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
  const usable = found.filter(
    (album) => album.assetCount > 0 && album.title.toLowerCase() !== ALL_PHOTOS_LABEL.toLowerCase()
  );

  const entries = await Promise.all(
    usable.map(async (album): Promise<AlbumEntry | null> => {
      try {
        const cover = await MediaLibrary.getAssetsAsync({
          first: 1,
          album: album.id,
          mediaType: [MediaLibrary.MediaType.photo],
          sortBy: [MediaLibrary.SortBy.creationTime],
        });
        // No photos in it, whatever `assetCount` claimed -- an album of
        // videos counts them, and this grid can't show any of them.
        if (cover.assets.length === 0) return null;
        return {
          id: album.id,
          title: album.title,
          count: cover.totalCount,
          coverUri: cover.assets[0].uri,
        };
      } catch {
        return null;
      }
    })
  );

  return entries
    .filter((entry): entry is AlbumEntry => entry !== null)
    .sort((a, b) => b.count - a.count);
}

function AlbumRow({
  title,
  count,
  coverUri,
  selected,
  onPress,
}: {
  title: string;
  count?: number;
  coverUri?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors, typography } = useTheme();
  return (
    <Pressable onPress={onPress} style={styles.albumRow}>
      <View style={[styles.albumCover, { backgroundColor: colors.imagePlaceholder }]}>
        {coverUri ? (
          <Image
            source={coverUri}
            style={styles.cellImage}
            contentFit="cover"
            cachePolicy="memory-disk"
            accessible={false}
          />
        ) : (
          <Feather name="image" size={16} color={colors.textSecondary} />
        )}
      </View>
      <View style={styles.albumText}>
        <Text style={[typography.body, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        {count !== undefined ? (
          <Text style={[typography.meta, { color: colors.textSecondary }]}>{count}</Text>
        ) : null}
      </View>
      {selected ? <Feather name="check" size={18} color={colors.accent} /> : null}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------

/** The largest frame of the given aspect ratio that fits inside `pane`. */
function fitFrame(aspect: number, pane: ImageSize): ImageSize {
  const width = Math.min(pane.width, pane.height * aspect);
  return { width: Math.round(width), height: Math.round(width / aspect) };
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    borderBottomWidth: hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: '600' },
  // Stands in for Cancel so the title stays centred under space-between.
  headerSpacer: { width: 48 },
  disabled: { opacity: 0.4 },
  // Always black: this is photo letterboxing, which doesn't follow the
  // screen's light/dark state any more than a photo viewer's backdrop does.
  // Clips the inner (always pane.height) box as paneWrapStyle's animated
  // height shrinks it -- same reasoning as the pane's own background: photo
  // letterboxing, not a themed surface.
  paneWrap: { backgroundColor: '#000', overflow: 'hidden' },
  pane: { backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  aspectButton: {
    position: 'absolute',
    left: spacing.md,
    bottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  aspectLabel: { color: '#fff', fontSize: 12, fontWeight: '600' },
  toolbar: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    borderBottomWidth: hairlineWidth,
  },
  sourceButton: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  sourceChevron: { marginLeft: spacing.xs },
  cameraButton: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  limitedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  list: { flex: 1 },
  row: { gap: GUTTER },
  content: { gap: GUTTER },
  cellImage: { width: '100%', height: '100%' },
  selectedDim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(255,255,255,0.35)' },
  selectedRing: {
    ...StyleSheet.absoluteFill,
    borderWidth: 2,
    borderColor: '#fff',
  },
  listSpinner: { paddingVertical: spacing.xxl },
  emptyState: { paddingVertical: spacing.xxl, alignItems: 'center' },
  backdrop: { ...StyleSheet.absoluteFill },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '70%',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: spacing.sm,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    marginBottom: spacing.sm,
  },
  sheetContent: { paddingBottom: spacing.xxl },
  albumsSpinner: { paddingVertical: spacing.lg },
  albumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  albumCover: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  albumText: { flex: 1, gap: 2 },
});

export default LibraryPicker;
