import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Dimensions,
  KeyboardAvoidingView,
  PixelRatio,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { Image } from 'expo-image';
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import { Tabs, useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { FilterStrip } from '../../components/FilterStrip';
import { FilterPreview } from '../../components/FilterPreview';
import { EmptyState } from '../../components/EmptyState';
import { PhotoLibraryGrid } from '../../components/PhotoLibraryGrid';
import { CropAdjust } from '../../components/CropAdjust';
import type { CropAdjustHandle } from '../../components/CropAdjust';
import { displayAspectRatio } from '../../components/PostCard';
import { FILTERS, getFilter } from '../../lib/filters';
import { bakeFilteredImage, downscaleForPreview } from '../../lib/bake';
import { supabase, PHOTOS_BUCKET } from '../../lib/supabase';
import { useUpdateProfile } from '../../lib/queries';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';
import type { CropRect } from '../../lib/types';

const SCREEN = Dimensions.get('window').width;
// The composer preview is a single canvas (unlike FilterStrip's 18 at once,
// which downscales further itself -- see THUMB_SOURCE_EDGE in
// FilterStrip.tsx), so there's no cost reason to keep it small. Sized off the
// device's actual pixel density so it's never blurrier than the screen it's
// rendered on.
const PREVIEW_MAX_EDGE = Math.round(SCREEN * PixelRatio.get());

/** The photo as picked, before any crop has been chosen. */
type RawPick = { uri: string; width: number; height: number };
/** The photo once its crop is locked in -- what the filter/share steps use. */
type Picked = RawPick & { previewUri: string; crop: CropRect };

/**
 * Four steps: pick (in-app library grid, or straight to the camera), adjust
 * the framing, choose the look, then write the caption -- library and
 * camera both funnel into the same adjust step so a photo always gets the
 * same reframing chance regardless of where it came from.
 */
type Step = 'library' | 'adjust' | 'filter' | 'share';

type Source = 'camera' | 'library';

/**
 * Requests a permission, then re-checks it once if the request came back
 * not-granted. Android has a known race (expo/expo#20096) where the OS
 * dialog is answered "allow" but the request call's own response doesn't
 * reflect that yet -- without this, that shows up as "Can't open that" on
 * the very first try, and every retry re-opens the whole source-choice
 * sheet from scratch.
 */
async function requestCameraPermissionWithRetry(): Promise<ImagePicker.PermissionResponse> {
  const first = await ImagePicker.requestCameraPermissionsAsync();
  if (first.granted || !first.canAskAgain) return first;
  await new Promise((resolve) => setTimeout(resolve, 300));
  return ImagePicker.getCameraPermissionsAsync();
}

/** Same retry shape as the camera one above, against expo-media-library's
 * own separate permission system -- the in-app library grid reads the
 * library directly, it doesn't go through expo-image-picker at all. */
async function requestLibraryPermissionWithRetry(): Promise<MediaLibrary.PermissionResponse> {
  const first = await MediaLibrary.requestPermissionsAsync();
  if (first.granted || !first.canAskAgain) return first;
  await new Promise((resolve) => setTimeout(resolve, 300));
  return MediaLibrary.getPermissionsAsync();
}

/**
 * Camera or library, asked with the platform's own sheet so nothing of ours
 * has to render first. The tab is a shutter button; putting a screen in front
 * of the picker just to hold two buttons made it flash on the way past.
 */
function chooseSource(): Promise<Source | null> {
  if (Platform.OS === 'ios') {
    return new Promise((resolve) => {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', 'Take Photo', 'Choose from Library'],
          cancelButtonIndex: 0,
        },
        (index) => resolve(index === 1 ? 'camera' : index === 2 ? 'library' : null)
      );
    });
  }
  return new Promise((resolve) => {
    Alert.alert('New post', undefined, [
      { text: 'Take Photo', onPress: () => resolve('camera') },
      { text: 'Choose from Library', onPress: () => resolve('library') },
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
    ]);
  });
}

export default function NewPost() {
  const router = useRouter();
  const qc = useQueryClient();
  const { session, profile, refreshProfile } = useAuth();
  const updateProfile = useUpdateProfile();
  const { colors } = useTheme();
  // A brand-new account is forced here for its first post (see the redirect
  // in app/_layout.tsx); the tab bar has nowhere useful to go until then.
  // === false, not !profile.onboarded -- an undefined column (migration not
  // yet run) must not be treated as forced-onboarding, same reasoning as
  // the redirect in app/_layout.tsx.
  const isForcedFirstPost = !!profile && profile.onboarded === false;

  // Not 'library' -- that branch below renders unconditionally on its own
  // (unlike 'adjust', which also requires rawPicked), so defaulting to it
  // would flash the grid open before launch() has even asked Take Photo vs.
  // Choose from Library. 'filter' is safe as a placeholder: its branch sits
  // behind the `!picked` guard, which is true until a crop is confirmed.
  const [step, setStep] = useState<Step>('filter');
  const [rawPicked, setRawPicked] = useState<RawPick | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [filterName, setFilterName] = useState(FILTERS[0].name);
  const [caption, setCaption] = useState('');
  const [posting, setPosting] = useState(false);
  /** Set when a permission was refused, so there's something to retry from. */
  const [blocked, setBlocked] = useState<string | null>(null);
  /**
   * True while a selection is being turned into the next step -- resolving a
   * library asset's real file, or downscaling a locked-in crop into the
   * filter step's preview. Shown as a spinner in place of "Next" rather than
   * a separate blank screen, so it never reads as the app having reset.
   */
  const [processing, setProcessing] = useState(false);

  const [selectedAsset, setSelectedAsset] = useState<MediaLibrary.Asset | null>(null);
  const [selectedPreviewUri, setSelectedPreviewUri] = useState<string | null>(null);
  const cropRef = useRef<CropAdjustHandle>(null);

  const filter = getFilter(filterName) ?? FILTERS[0];
  const isNormal = filter.name === 'Normal';
  // Real dimensions once a photo's picked; 1 (square) beforehand -- this runs
  // every render regardless of `rawPicked` to keep hook order stable, same
  // as every other hook in this component sitting above the early returns
  // below. picked.width/height are always copied straight from rawPicked
  // (the crop only ever adds a sub-rect, never changes what "natural" means),
  // so this one value is valid for both the adjust step's frame and the
  // filter step's preview canvas.
  const aspectRatio = useMemo(
    () => (rawPicked ? displayAspectRatio(rawPicked.width, rawPicked.height) : 1),
    [rawPicked]
  );

  /** Guards the focus effect against re-entering while a picker is already up. */
  const picking = useRef(false);

  // useFocusEffect re-invokes its callback whenever the callback's identity
  // changes while the screen is still focused, not just on real navigation
  // transitions. Closing over this state directly meant clearing it after a
  // successful post (still on this screen, mid-navigate-away) looked
  // identical to a fresh focus and relaunched the picker. Refs keep the
  // callback identity stable so only genuine focus events trigger it.
  const stepRef = useRef(step);
  const blockedRef = useRef(blocked);
  useEffect(() => {
    stepRef.current = step;
    blockedRef.current = blocked;
  }, [step, blocked]);

  const launch = useCallback(async () => {
    if (picking.current) return;
    picking.current = true;
    setBlocked(null);
    try {
      const source = await chooseSource();
      if (!source) {
        // Backing out of the sheet means backing out of posting.
        router.replace('/(tabs)');
        return;
      }

      if (source === 'library') {
        const permission = await requestLibraryPermissionWithRetry();
        if (!permission.granted) {
          setBlocked('Kalos needs photo library access to post.');
          return;
        }
        setStep('library');
        return;
      }

      const permission = await requestCameraPermissionWithRetry();
      if (!permission.granted) {
        setBlocked('Kalos needs camera access to take a photo.');
        return;
      }

      // No forced crop here either -- CropAdjust is what gives a photo its
      // framing now, uniformly for both camera and library.
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 1,
      });
      if (result.canceled || !result.assets[0]) {
        router.replace('/(tabs)');
        return;
      }

      const asset = result.assets[0];
      setRawPicked({ uri: asset.uri, width: asset.width, height: asset.height });
      setStep('adjust');
    } catch (e) {
      // The simulator has no camera, and that surfaces here rather than as a
      // permission refusal.
      setBlocked(e instanceof Error ? e.message : 'Could not open the camera.');
    } finally {
      picking.current = false;
    }
  }, [router]);

  useFocusEffect(
    useCallback(() => {
      if (!blockedRef.current && stepRef.current !== 'library' && stepRef.current !== 'adjust') {
        void launch();
      }
    }, [launch])
  );

  const discard = useCallback(() => {
    // 'filter', not 'library' -- same reasoning as the initial state above.
    // If this component doesn't fully unmount before the tab's focused
    // again, a stale 'library'/'adjust' step would skip launch()'s
    // Take Photo vs. Choose from Library sheet entirely.
    setStep('filter');
    setRawPicked(null);
    setPicked(null);
    setSelectedAsset(null);
    setSelectedPreviewUri(null);
    setCaption('');
    router.replace('/(tabs)');
  }, [router]);

  const handleSelectAsset = useCallback((asset: MediaLibrary.Asset) => {
    setSelectedAsset(asset);
    setSelectedPreviewUri(null);
    asset
      .getUri()
      .then(setSelectedPreviewUri)
      .catch(() => undefined);
  }, []);

  const confirmLibrarySelection = useCallback(async () => {
    if (!selectedAsset) return;
    setProcessing(true);
    try {
      const info = await selectedAsset.getInfo();
      setRawPicked({ uri: info.uri, width: info.width, height: info.height });
      setStep('adjust');
    } catch (e) {
      Alert.alert('Could not use that photo', e instanceof Error ? e.message : undefined);
    } finally {
      setProcessing(false);
    }
  }, [selectedAsset]);

  const confirmCrop = useCallback(async () => {
    if (!rawPicked || !cropRef.current) return;
    setProcessing(true);
    try {
      const crop = cropRef.current.getCropRect();
      // The preview runs against a downscaled copy sized to the screen's own
      // resolution (still far smaller than the original for most photos);
      // the full-resolution image is only touched once, at post time.
      const preview = await downscaleForPreview(rawPicked.uri, PREVIEW_MAX_EDGE);
      setPicked({ ...rawPicked, previewUri: preview.uri, crop });
      setStep('filter');
      setFilterName(FILTERS[0].name);
      setCaption('');
    } catch (e) {
      Alert.alert('Could not use that photo', e instanceof Error ? e.message : undefined);
    } finally {
      setProcessing(false);
    }
  }, [rawPicked]);

  const share = useCallback(async () => {
    if (!picked || !session) return;
    setPosting(true);

    // The post itself lives or dies here. Once the insert succeeds, the post
    // is real and done -- nothing after this point is allowed to make it
    // look like posting failed, because a user told "could not post" will
    // reasonably retry, and retrying re-runs this whole function, which
    // would upload a second copy and insert a second row.
    try {
      const baked = await bakeFilteredImage({
        uri: picked.uri,
        filter,
        strength: 1,
        crop: picked.crop,
      });

      const id = randomUUID();
      const path = `${session.user.id}/${id}.jpg`;
      const bytes = await new File(baked.uri).bytes();

      const { error: uploadError } = await supabase.storage
        .from(PHOTOS_BUCKET)
        .upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
      if (uploadError) throw uploadError;

      // A small derivative for grid contexts (Explore, profile grids) --
      // generated from the already-filtered bake output so it matches what
      // actually got posted, not the unfiltered original. Without this,
      // every ~130pt grid tile was decoding the same full-quality
      // (maxEdge 2560, quality 100) image as the feed, which is what made
      // scrolling those grids sluggish, especially on Android.
      const thumb = await downscaleForPreview(baked.uri, 400);
      const thumbPath = `${session.user.id}/${id}_thumb.jpg`;
      const thumbBytes = await new File(thumb.uri).bytes();

      const { error: thumbUploadError } = await supabase.storage
        .from(PHOTOS_BUCKET)
        .upload(thumbPath, thumbBytes, { contentType: 'image/jpeg', upsert: false });
      if (thumbUploadError) throw thumbUploadError;

      const { error: insertError } = await supabase.from('posts').insert({
        author_id: session.user.id,
        image_path: path,
        thumb_path: thumbPath,
        width: baked.width,
        height: baked.height,
        caption: caption.trim() || null,
        filter_name: isNormal ? null : filter.name,
      });
      if (insertError) throw insertError;
    } catch (e) {
      Alert.alert('Could not post', e instanceof Error ? e.message : 'Something went wrong.');
      setPosting(false);
      return;
    }

    qc.invalidateQueries({ queryKey: ['home_feed'] });
    qc.invalidateQueries({ queryKey: ['profile-posts'] });
    qc.invalidateQueries({ queryKey: ['profile'] });
    qc.invalidateQueries({ queryKey: ['posted-today'] });
    setPicked(null);
    setCaption('');
    router.replace('/(tabs)');

    // Best-effort cleanup from here on -- a failure here must never be
    // reported as "could not post" (it already did) and must never block
    // leaving this screen. If the flag flip below fails, the final
    // refreshProfile() still picks up the real post_count from the DB, and
    // app/_layout.tsx's redirect only re-forces this screen while
    // post_count is 0 -- so a failed flag flip alone can no longer strand
    // anyone here, it just retries itself next time onboarding-gated code runs.
    if (isForcedFirstPost) {
      try {
        await updateProfile.mutateAsync({ onboarded: true });
      } catch (e) {
        console.warn('onboarding flag flip failed, will self-heal on next post', e);
      }
    }
    // AuthProvider's profile is separate state from the react-query cache
    // above -- the redirect in app/_layout.tsx reads post_count and
    // onboarded off of it, so it needs its own explicit refresh.
    await refreshProfile();
    setPosting(false);
  }, [
    picked,
    session,
    filter,
    isNormal,
    caption,
    qc,
    router,
    isForcedFirstPost,
    updateProfile,
    refreshProfile,
  ]);

  // A forced first post has nowhere else to send you, so the tab bar itself
  // is hidden rather than just non-functional.
  const hideTabBar = isForcedFirstPost ? (
    <Tabs.Screen options={{ tabBarStyle: { display: 'none' } }} />
  ) : null;

  if (step === 'library') {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
        {hideTabBar}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={discard} hitSlop={12} disabled={processing}>
            <Text style={[styles.headerAction, { color: colors.text }, processing && styles.disabled]}>
              Cancel
            </Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>New post</Text>
          <Pressable onPress={confirmLibrarySelection} hitSlop={12} disabled={!selectedAsset || processing}>
            {processing ? (
              <ActivityIndicator size="small" />
            ) : (
              <Text
                style={[
                  styles.headerAction,
                  styles.forward,
                  { color: colors.accent },
                  !selectedAsset && styles.disabled,
                ]}
              >
                Next
              </Text>
            )}
          </Pressable>
        </View>

        <View style={[styles.libraryPreview, { backgroundColor: '#000' }]}>
          {selectedPreviewUri ? (
            <Image source={selectedPreviewUri} style={styles.image} contentFit="contain" />
          ) : null}
        </View>

        <PhotoLibraryGrid
          selectedAssetId={selectedAsset?.id ?? null}
          onSelect={handleSelectAsset}
          onFirstLoad={handleSelectAsset}
          containerWidth={SCREEN}
          style={styles.grid}
        />
      </SafeAreaView>
    );
  }

  if (step === 'adjust' && rawPicked) {
    const frame = { width: SCREEN, height: SCREEN / aspectRatio };
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
        {hideTabBar}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={discard} hitSlop={12} disabled={processing}>
            <Text style={[styles.headerAction, { color: colors.text }, processing && styles.disabled]}>
              Cancel
            </Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>New post</Text>
          <Pressable onPress={confirmCrop} hitSlop={12} disabled={processing}>
            {processing ? (
              <ActivityIndicator size="small" />
            ) : (
              <Text style={[styles.headerAction, styles.forward, { color: colors.accent }]}>Next</Text>
            )}
          </Pressable>
        </View>

        <View style={styles.adjustBody}>
          <CropAdjust
            ref={cropRef}
            uri={rawPicked.uri}
            natural={{ width: rawPicked.width, height: rawPicked.height }}
            frame={frame}
          />
        </View>
      </SafeAreaView>
    );
  }

  if (!picked) {
    // Bare while the native camera/permission sheet is up -- anything drawn
    // here would flash for the moment before it covers the screen.
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
        {hideTabBar}
        {blocked ? (
          <>
            <View style={[styles.header, { borderBottomColor: colors.border }]}>
              <Text style={[styles.title, { color: colors.text }]}>New post</Text>
            </View>
            <EmptyState
              icon="camera-off"
              title="Can't open that"
              body={blocked}
              actionLabel="Try again"
              onAction={launch}
            />
          </>
        ) : null}
      </SafeAreaView>
    );
  }

  if (step === 'filter') {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
        {hideTabBar}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={discard} hitSlop={12}>
            <Text style={[styles.headerAction, { color: colors.text }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>New post</Text>
          <Pressable onPress={() => setStep('share')} hitSlop={12}>
            <Text style={[styles.headerAction, styles.forward, { color: colors.accent }]}>Next</Text>
          </Pressable>
        </View>

        <ScrollView keyboardShouldPersistTaps="handled">
          <FilterPreview
            uri={picked.previewUri}
            filter={filter}
            strength={1}
            size={{ width: SCREEN, height: SCREEN / aspectRatio }}
            style={styles.preview}
          />

          <FilterStrip
            uri={picked.previewUri}
            selectedFilterName={filterName}
            thumbSize={84}
            onSelect={setFilterName}
          />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top', 'bottom']}>
      {hideTabBar}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => setStep('filter')} hitSlop={12} disabled={posting}>
          <Text style={[styles.headerAction, { color: colors.text }, posting && styles.disabled]}>
            Back
          </Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>New post</Text>
        <Pressable onPress={share} hitSlop={12} disabled={posting}>
          {posting ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text style={[styles.headerAction, styles.forward, { color: colors.accent }]}>Share</Text>
          )}
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={styles.shareBody}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.captionRow}>
          <FilterPreview
            uri={picked.previewUri}
            filter={filter}
            strength={1}
            size={72}
            style={[styles.thumb, { backgroundColor: colors.imagePlaceholder }]}
          />
          <TextInput
            style={[styles.caption, { color: colors.text }]}
            placeholder="Write a caption…"
            placeholderTextColor={colors.textSecondary}
            value={caption}
            onChangeText={setCaption}
            multiline
            autoFocus
            maxLength={2200}
          />
        </View>
        {!isNormal && (
          <Text style={[styles.appliedFilter, { color: colors.textSecondary }]}>{filter.name}</Text>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: '600' },
  headerAction: { fontSize: 15 },
  forward: { fontWeight: '600' },
  disabled: { opacity: 0.4 },
  // Always black, not theme-driven -- this is photo letterboxing, the same
  // way a photo/video viewer's background stays black regardless of theme.
  preview: { backgroundColor: '#000' },
  libraryPreview: { width: '100%', aspectRatio: 1 },
  image: { width: '100%', height: '100%' },
  grid: { flex: 1 },
  adjustBody: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
  shareBody: { flex: 1 },
  captionRow: { flexDirection: 'row', gap: 12, padding: 16 },
  thumb: { borderRadius: 3, overflow: 'hidden' },
  caption: { flex: 1, fontSize: 15, paddingTop: 2, minHeight: 72 },
  appliedFilter: {
    paddingHorizontal: 16,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
});
