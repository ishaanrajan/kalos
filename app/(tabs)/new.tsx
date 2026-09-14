import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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
import * as MediaLibrary from 'expo-media-library/legacy';
import { randomUUID } from 'expo-crypto';
import Ionicons from '@expo/vector-icons/Ionicons';
import { File } from 'expo-file-system';
import { Tabs, useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { FilterStrip } from '../../components/FilterStrip';
import { FilterPreview } from '../../components/FilterPreview';
import { EmptyState } from '../../components/EmptyState';
import { LibraryPicker } from '../../components/LibraryPicker';
import { CropAdjust } from '../../components/CropAdjust';
import type { CropAdjustHandle } from '../../components/CropAdjust';
import { displayAspectRatio } from '../../components/PostCard';
import { FILTERS, getFilter } from '../../lib/filters';
import type { CropRect, ImageSize } from '../../lib/types';
import { bakeFilteredImage, downscaleForPreview, prepareSource } from '../../lib/bake';
import { supabase, PHOTOS_BUCKET } from '../../lib/supabase';
import { useUpdateProfile } from '../../lib/queries';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';
import { useMusic } from '../../lib/audio';
import { trackToPostMusic, type Track } from '../../lib/music';
import { MusicPicker } from '../../components/MusicPicker';
import { setUpdatePromptSuppressed } from '../../lib/updates';

const SCREEN = Dimensions.get('window').width;
// The composer preview is a single canvas (unlike FilterStrip's 18 at once,
// which downscales further itself -- see THUMB_SOURCE_EDGE in
// FilterStrip.tsx), so there's no cost reason to keep it small. Sized off the
// device's actual pixel density so it's never blurrier than the screen it's
// rendered on.
const PREVIEW_MAX_EDGE = Math.round(SCREEN * PixelRatio.get());

/** The photo as picked, before any crop has been chosen. */
type RawPick = { uri: string; width: number; height: number };
/**
 * The photo once its crop is locked in -- what the filter/share steps use.
 *
 * `uri`/`width`/`height` describe the *prepared* image (see prepareSource in
 * lib/bake), not the original pick: already cropped to the framed region,
 * turned upright, and capped at SOURCE_MAX_EDGE. That matters because these
 * are the numbers that become the posted row's width/height and the preview's
 * aspect ratio, and after a crop the original's dimensions describe an image
 * nobody is going to see. There's deliberately no crop rect here any more --
 * the crop is already in the pixels, so there is no second place it could be
 * applied inconsistently.
 */
type Picked = { uri: string; width: number; height: number; previewUri: string };

/**
 * Pick a photo, choose the look, write the caption.
 *
 * 'library' is the composer's front door: the picker frames the photo on the
 * same screen it's chosen from, so the library path has no separate adjust
 * step to pass through. 'adjust' is the camera's -- a freshly shot photo has
 * had no chance at a framing yet, and giving it the same crop surface is what
 * keeps a posted photo the same shape regardless of where it came from.
 */
type Step = 'library' | 'adjust' | 'filter' | 'share' | 'music';

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
  // would flash the grid open before launch() has even resolved the photo
  // library permission. 'filter' is safe as a placeholder: its branch sits
  // behind the `!picked` guard, which is true until a crop is confirmed.
  const [step, setStep] = useState<Step>('filter');
  const [rawPicked, setRawPicked] = useState<RawPick | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [filterName, setFilterName] = useState(FILTERS[0].name);
  const [caption, setCaption] = useState('');
  const [musicTrack, setMusicTrack] = useState<Track | null>(null);
  const [musicStartMs, setMusicStartMs] = useState(0);
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

  const { stop: stopMusic } = useMusic();

  const cropRef = useRef<CropAdjustHandle>(null);
  const postingRef = useRef(false);

  const filter = getFilter(filterName) ?? FILTERS[0];
  const isNormal = filter.name === 'Normal';
  // Real dimensions once a photo's picked; 1 (square) beforehand -- these run
  // every render regardless of `rawPicked`/`picked` to keep hook order stable,
  // same as every other hook in this component sitting above the early returns
  // below.
  //
  // Two ratios, not one. The adjust step's frame is the shape the user is
  // choosing a crop *into*, so it comes from the original's dimensions. The
  // filter step's canvas shows an image that has already been cropped to that
  // frame, so it has to come from the prepared image's own dimensions. They
  // land on nearly the same number by construction, but only nearly: the crop
  // rect gets rounded to whole pixels and displayAspectRatio clamps and snaps
  // to square, so deriving the preview's shape from the pre-crop numbers is
  // how you get a canvas that letterboxes an image that already fits it.
  const frameAspectRatio = useMemo(
    () => (rawPicked ? displayAspectRatio(rawPicked.width, rawPicked.height) : 1),
    [rawPicked]
  );
  const previewAspectRatio = useMemo(
    () => (picked ? displayAspectRatio(picked.width, picked.height) : 1),
    [picked]
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
  const rawPickedRef = useRef(rawPicked);
  const pickedRef = useRef(picked);
  useEffect(() => {
    stepRef.current = step;
    blockedRef.current = blocked;
    rawPickedRef.current = rawPicked;
    pickedRef.current = picked;
  }, [step, blocked, rawPicked, picked]);

  /**
   * The composer opens straight into the library, with the camera one tap
   * away inside it. It used to open a Take Photo / Choose from Library action
   * sheet first, which is the 2015 iOS idiom rather than the one Instagram
   * uses now -- and it meant the common case (posting a photo you already
   * took) cost a modal, a decision and a dismissal before anything appeared,
   * with a blank screen underneath the whole time.
   */
  const launch = useCallback(async () => {
    if (picking.current) return;
    picking.current = true;
    setBlocked(null);
    try {
      const permission = await requestLibraryPermissionWithRetry();
      if (!permission.granted) {
        setBlocked('Kalos needs photo library access to post.');
        return;
      }
      setStep('library');
    } finally {
      picking.current = false;
    }
  }, []);

  /**
   * Failures here are surfaced as an alert rather than through `blocked`:
   * the camera is reached from inside the picker, which is still sitting
   * there perfectly usable underneath, so replacing it with a full-screen
   * error would be throwing away a working screen over a detour that didn't
   * work out.
   */
  const openCamera = useCallback(async () => {
    if (picking.current) return;
    picking.current = true;
    try {
      const permission = await requestCameraPermissionWithRetry();
      if (!permission.granted) {
        Alert.alert('Can’t open the camera', 'Kalos needs camera access to take a photo.');
        return;
      }

      // No forced crop here -- CropAdjust is what gives a photo its framing,
      // uniformly for both camera and library.
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 1,
      });
      // Backing out of the camera returns to the picker rather than out of
      // the composer -- it's a detour from the library, not a step in front
      // of it, so cancelling it shouldn't throw away the whole trip.
      if (result.canceled || !result.assets[0]) return;

      const asset = result.assets[0];
      setRawPicked({ uri: asset.uri, width: asset.width, height: asset.height });
      setStep('adjust');
    } catch (e) {
      // The simulator has no camera, and that surfaces here rather than as a
      // permission refusal.
      Alert.alert('Can’t open the camera', e instanceof Error ? e.message : undefined);
    } finally {
      picking.current = false;
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      // Only ever auto-launch into a genuinely empty composer. This tab is
      // never unmounted, so every trip to another tab and back is a focus
      // event, and the old test -- "any step other than library/adjust" --
      // treated a half-written post on the filter or share step as if it were
      // a cold start. That put the Take Photo / Choose from Library sheet on
      // top of the user's own work, and backing out of that sheet runs
      // launch()'s cancel path, which replaces the route and throws away the
      // photo they had already framed. A photo in hand (either the raw pick
      // mid-adjust or the prepared one) means there is nothing to launch.
      if (
        blockedRef.current ||
        rawPickedRef.current ||
        pickedRef.current ||
        stepRef.current === 'library'
      ) {
        return;
      }
      void launch();
    }, [launch])
  );

  const discard = useCallback(() => {
    // 'filter', not 'library' -- same reasoning as the initial state above.
    // If this component doesn't fully unmount before the tab's focused
    // again, a stale 'library'/'adjust' step would skip launch() entirely and
    // leave the composer sitting on the last post's leftovers.
    setStep('filter');
    setRawPicked(null);
    setPicked(null);
    setCaption('');
    setMusicTrack(null);
    setMusicStartMs(0);
    stopMusic();
    router.replace('/(tabs)');
  }, [router, stopMusic]);

  /**
   * A framed photo becomes the one image the rest of the composer works from.
   *
   * Bake the framing into a real file right here, once, and let every later
   * step read from that. The rect the user chose is applied natively (which
   * also turns an EXIF-rotated photo upright, since the rect was measured in
   * the upright space they were looking at), and the result is capped at
   * SOURCE_MAX_EDGE so the original's full resolution never has to be decoded
   * again -- not for the preview, and not on the JS thread at post time.
   *
   * Both files come out of one decode of the original: the capped source the
   * bake reads, and the preview the filter step shows. They're the same
   * pixels by construction, so the filter you pick and the thumbnail beside
   * the caption match what actually gets uploaded.
   *
   * Shared by both entry points. The library picker and the camera's adjust
   * step arrive here with exactly the same three things -- a file, its true
   * dimensions, and a rect in that file's pixel space -- so there is one
   * place where a crop turns into a post, not two that have to agree.
   */
  const prepareFramed = useCallback(
    async ({ uri, natural, crop }: { uri: string; natural: ImageSize; crop: CropRect }) => {
      setProcessing(true);
      try {
        const { source, preview } = await prepareSource(uri, crop, natural, PREVIEW_MAX_EDGE);
        setPicked({
          uri: source.uri,
          width: source.width,
          height: source.height,
          previewUri: preview.uri,
        });
        setRawPicked(null);
        setStep('filter');
        setFilterName(FILTERS[0].name);
        setCaption('');
      } catch (e) {
        Alert.alert('Could not use that photo', e instanceof Error ? e.message : undefined);
      } finally {
        setProcessing(false);
      }
    },
    []
  );

  const confirmCrop = useCallback(async () => {
    if (!rawPicked || !cropRef.current) return;
    const natural = { width: rawPicked.width, height: rawPicked.height };
    await prepareFramed({ uri: rawPicked.uri, natural, crop: cropRef.current.getCrop(natural) });
  }, [rawPicked, prepareFramed]);

  const share = useCallback(async () => {
    if (!picked || !session) return;
    // `disabled={posting}` relies on a re-render landing before the next tap,
    // which is exactly what a busy JS thread mid-bake can't promise. A ref
    // flips synchronously, so a double tap can't start a second upload of
    // the same photo.
    if (postingRef.current) return;
    postingRef.current = true;
    setPosting(true);

    // Paths written to storage so far. If the post fails after an upload has
    // landed, these are removed -- otherwise every retry mints a fresh UUID
    // and abandons the previous pair in the bucket, billed forever, with no
    // post to show for them and nothing that ever sweeps them up.
    let uploaded: string[] = [];
    // Which step we're on, so a failure can say so instead of just "could not post".
    let stage = 'preparing';

    // An OTA update prompt landing mid-upload would offer "Restart now",
    // and reloadAsync() tears down the JS context immediately -- throwing
    // away the photo, the filter and the caption, right at the moment the
    // user has the most invested in them. Hold the prompt until this is
    // done; the foreground check will simply ask on the next foreground.
    setUpdatePromptSuppressed(true);

    // The post itself lives or dies here. Once the insert succeeds, the post
    // is real and done -- nothing after this point is allowed to make it
    // look like posting failed, because a user told "could not post" will
    // reasonably retry, and retrying re-runs this whole function, which
    // would upload a second copy and insert a second row.
    try {
      // No `crop` and no re-normalising: picked.uri is already the cropped,
      // upright, size-capped file prepareSource() wrote at confirmCrop time,
      // so Skia decodes at most SOURCE_MAX_EDGE here instead of pulling a
      // 48MP original into native memory through JSI while the user waits.
      // Real Instagram exports feed photos around 1080-1440px -- no phone
      // screen renders a post wider than that. The previous 2560/quality-100
      // default made every post a multi-MB near-lossless JPEG, which is what
      // was making posting itself slow (and, on a flaky connection, more
      // likely to drop mid-upload and surface as "something went wrong").
      stage = 'filtering';
      const baked = await bakeFilteredImage({
        uri: picked.uri,
        filter,
        strength: 1,
        preNormalized: true,
        maxEdge: 1440,
        quality: 90,
      });

      const id = randomUUID();
      const path = `${session.user.id}/${id}.jpg`;
      const thumbPath = `${session.user.id}/${id}_thumb.jpg`;
      uploaded = [];

      // A small derivative for grid contexts (Explore, profile grids) --
      // generated from the already-filtered bake output so it matches what
      // actually got posted, not the unfiltered original. Without this,
      // every ~130pt grid tile was decoding the same full-quality
      // (maxEdge 2560, quality 100) image as the feed, which is what made
      // scrolling those grids sluggish, especially on Android.
      stage = 'thumbnail';
      const thumb = await downscaleForPreview(baked.uri, 400);
      const [bytes, thumbBytes] = await Promise.all([
        new File(baked.uri).bytes(),
        new File(thumb.uri).bytes(),
      ]);

      // Both uploads at once. They're independent objects in the same folder
      // and the full-size one is by far the longer wait, so running the
      // 50KB thumbnail behind it was adding a round trip to every post for
      // no reason.
      stage = 'upload';
      const [main, thumbUpload] = await Promise.all([
        supabase.storage
          .from(PHOTOS_BUCKET)
          .upload(path, bytes, { contentType: 'image/jpeg', upsert: false })
          .then((r) => {
            if (!r.error) uploaded.push(path);
            return r;
          }),
        supabase.storage
          .from(PHOTOS_BUCKET)
          .upload(thumbPath, thumbBytes, { contentType: 'image/jpeg', upsert: false })
          .then((r) => {
            if (!r.error) uploaded.push(thumbPath);
            return r;
          }),
      ]);
      if (main.error) throw main.error;
      if (thumbUpload.error) throw thumbUpload.error;

      stage = 'saving';
      const { error: insertError } = await supabase.from('posts').insert({
        author_id: session.user.id,
        image_path: path,
        thumb_path: thumbPath,
        width: baked.width,
        height: baked.height,
        caption: caption.trim() || null,
        filter_name: isNormal ? null : filter.name,
        music: musicTrack ? trackToPostMusic(musicTrack, musicStartMs) : null,
      });
      if (insertError) throw insertError;
    } catch (e) {
      if (uploaded.length) {
        await supabase.storage
          .from(PHOTOS_BUCKET)
          .remove(uploaded)
          .catch(() => undefined);
      }
      // Name the stage that actually failed. "Could not post" plus a bare
      // message is unactionable when the pipeline is bake -> 2 uploads ->
      // insert and any of the four can throw: the uploads can succeed and
      // the insert still fail, which looks identical from here.
      const detail =
        e && typeof e === 'object'
          ? [
              (e as { message?: string }).message,
              (e as { code?: string }).code && `code ${(e as { code?: string }).code}`,
              (e as { details?: string }).details,
              (e as { hint?: string }).hint,
            ]
              .filter(Boolean)
              .join('\n')
          : String(e);
      Alert.alert(`Could not post (${stage})`, detail || 'Something went wrong.');
      setPosting(false);
      postingRef.current = false;
      setUpdatePromptSuppressed(false);
      return;
    }
    postingRef.current = false;
    setUpdatePromptSuppressed(false);

    qc.invalidateQueries({ queryKey: ['home_feed'] });
    qc.invalidateQueries({ queryKey: ['profile-posts'] });
    qc.invalidateQueries({ queryKey: ['profile'] });
    qc.invalidateQueries({ queryKey: ['posted-today'] });
    // Clear everything, not just `picked` -- the focus effect now decides
    // whether to relaunch the picker by asking whether a photo is in hand, so
    // a leftover rawPicked from the post that just succeeded would read as
    // work-in-progress forever and the tab would stop opening the source
    // sheet at all. 'filter' as the resting step for the same reason it's the
    // initial one: see discard() above.
    setStep('filter');
    setRawPicked(null);
    setPicked(null);
    setCaption('');
    setMusicTrack(null);
    setMusicStartMs(0);
    stopMusic();
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
    musicTrack,
    musicStartMs,
    stopMusic,
    qc,
    router,
    isForcedFirstPost,
    updateProfile,
    refreshProfile,
  ]);

  // The composer is a flow, not a destination: once you're in it every screen
  // has its own Cancel, and the tab bar underneath is either a way to abandon
  // a half-written post without being asked or -- during a forced first post
  // -- a row of buttons with nowhere to go. Instagram's composer covers it for
  // the same reason. Scoped to this screen by React Navigation, so it comes
  // back on its own the moment the composer is left.
  const hideTabBar = <Tabs.Screen options={{ tabBarStyle: { display: 'none' } }} />;

  if (step === 'library') {
    // The picker owns the whole screen, header included -- it has a preview,
    // an album switcher and a camera button to place, and splitting that
    // chrome across two files is how the header ends up disagreeing with what
    // the screen underneath it can actually do.
    return (
      <>
        {hideTabBar}
        <LibraryPicker onCancel={discard} onOpenCamera={openCamera} onNext={prepareFramed} />
      </>
    );
  }

  if (step === 'adjust' && rawPicked) {
    const frame = { width: SCREEN, height: SCREEN / frameAspectRatio };
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
        {hideTabBar}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          {/* Back to the picker, not out of the composer: the camera is a
              detour from the library, so undoing the shot should return you
              to where you took it from. */}
          <Pressable
            onPress={() => {
              setRawPicked(null);
              setStep('library');
            }}
            hitSlop={12}
            disabled={processing}
          >
            <Text style={[styles.headerAction, { color: colors.text }, processing && styles.disabled]}>
              Back
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
            // The picker's own metadata can disagree with what actually
            // gets decoded (Android's MediaStore reports pre-rotation
            // width/height for EXIF-rotated photos) -- correcting
            // rawPicked in place here is what CropAdjust's own `natural`
            // doc comment calls "how a wrong one gets fixed", and it's
            // also what confirmCrop below reads when it calls getCrop(),
            // so a bad initial guess can't silently survive into the
            // actual crop math. Without this wired up, a landscape-vs-
            // portrait mismatch could make getCrop() compute a rect in
            // the wrong axis order entirely -- clampCropRect (lib/bake.ts)
            // would then clamp it toward covering the whole image, which
            // is why the symptom looked like "the crop I chose was
            // ignored" rather than an obviously wrong rectangle.
            onImageLoad={(size) => setRawPicked((prev) => (prev ? { ...prev, ...size } : prev))}
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
          {/* Back to the picker rather than out of the composer -- changing
              your mind about which photo shouldn't cost you the whole post,
              and every step from here on is already reversible. */}
          <Pressable onPress={() => setStep('library')} hitSlop={12}>
            <Text style={[styles.headerAction, { color: colors.text }]}>Back</Text>
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
            size={{ width: SCREEN, height: SCREEN / previewAspectRatio }}
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

  if (step === 'music') {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top', 'bottom']}>
        {hideTabBar}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={() => { stopMusic(); setStep('share'); }} hitSlop={12}>
            <Text style={[styles.headerAction, { color: colors.text }]}>Back</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Add music</Text>
          <Pressable onPress={() => { stopMusic(); setStep('share'); }} hitSlop={12}>
            <Text style={[styles.headerAction, styles.forward, { color: colors.accent }]}>Done</Text>
          </Pressable>
        </View>

        <MusicPicker
          selected={musicTrack}
          startMs={musicStartMs}
          onChangeSelected={setMusicTrack}
          onChangeStartMs={setMusicStartMs}
          width={SCREEN}
        />
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
        <Pressable
          onPress={() => setStep('music')}
          disabled={posting}
          style={[styles.musicRow, { borderTopColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel={musicTrack ? 'Change music' : 'Add music'}
        >
          <Ionicons name="musical-notes-outline" size={18} color={colors.text} />
          <Text style={[styles.musicLabel, { color: colors.text }]} numberOfLines={1}>
            {musicTrack ? `${musicTrack.title} · ${musicTrack.artist}` : 'Add music'}
          </Text>
          {musicTrack ? (
            <Pressable
              onPress={() => {
                setMusicTrack(null);
                setMusicStartMs(0);
                stopMusic();
              }}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Remove music"
            >
              <Ionicons name="close" size={18} color={colors.textSecondary} />
            </Pressable>
          ) : (
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          )}
        </Pressable>

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
  adjustBody: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
  shareBody: { flex: 1 },
  captionRow: { flexDirection: 'row', gap: 12, padding: 16 },
  thumb: { borderRadius: 3, overflow: 'hidden' },
  caption: { flex: 1, fontSize: 15, paddingTop: 2, minHeight: 72 },
  musicRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  musicLabel: { flex: 1, fontSize: 15 },
  appliedFilter: {
    paddingHorizontal: 16,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
});
