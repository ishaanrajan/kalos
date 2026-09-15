import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Dimensions,
  KeyboardAvoidingView,
  Linking,
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
import { File } from 'expo-file-system';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs, useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useImage } from '@shopify/react-native-skia';
import { FilterStrip } from '../../components/FilterStrip';
import { FilterPreview } from '../../components/FilterPreview';
import { EmptyState } from '../../components/EmptyState';
import { LibraryPicker } from '../../components/LibraryPicker';
import { CropAdjust } from '../../components/CropAdjust';
import type { CropAdjustHandle } from '../../components/CropAdjust';
import { displayAspectRatio } from '../../components/PostCard';
import { FILTERS, getFilter } from '../../lib/filters';
import type { CropRect, ImageSize, PostTag } from '../../lib/types';
import { downscaleForPreview, prepareSource } from '../../lib/bake';
import { getPostUploadState, startPost } from '../../lib/postUpload';
import { useFollowList, useUpdateProfile } from '../../lib/queries';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';
import { useMusic } from '../../lib/audio';
import { trackToPostMusic, type Track } from '../../lib/music';
import { MusicPicker } from '../../components/MusicPicker';
import { TagPeopleEditor } from '../../components/TagPeopleEditor';

const SCREEN = Dimensions.get('window').width;
// The composer preview is a single canvas (unlike FilterStrip's 18 at once,
// which work from the much smaller thumb below), so there's no cost reason
// to keep it small. Sized off the device's actual pixel density so it's
// never blurrier than the screen it's rendered on.
const PREVIEW_MAX_EDGE = Math.round(SCREEN * PixelRatio.get());
/** Longest edge of the copy the 18 filter thumbnails are drawn from. */
const THUMB_SOURCE_EDGE = 150;

/** The photo as picked, before any crop has been chosen. */
type RawPick = { uri: string; width: number; height: number; assetId: string };
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
 *
 * `previewUri` and `thumbUri` are decoded exactly once each, up in the
 * component (see previewImage/thumbImage), and the resulting SkImages are
 * what every preview surface draws from. Before that, each step decoded the
 * preview for itself on mount, and the filter strip re-downscaled the photo
 * from scratch every time you came back to it from Share -- 18 blank tiles
 * while it caught up.
 */
type Picked = {
  uri: string;
  width: number;
  height: number;
  previewUri: string;
  thumbUri: string;
  /** Which library asset (or camera shot) this came from, for change detection. */
  assetId: string;
};

/**
 * Pick a photo, choose the look, write the caption.
 *
 * 'library' is the composer's front door: the picker frames the photo on the
 * same screen it's chosen from, so the library path has no separate adjust
 * step to pass through. 'adjust' is the camera's -- a freshly shot photo has
 * had no chance at a framing yet, and giving it the same crop surface is what
 * keeps a posted photo the same shape regardless of where it came from.
 *
 * The library picker is mounted for the whole session -- from launch()
 * until discard() or a share -- and merely covered by the later steps, not
 * unmounted. Going Back from the filter step used to remount it: the grid
 * reloaded, the most recent photo got re-selected, and your zoom, album and
 * scroll position were gone. Now Back returns you to exactly the framing you
 * left. `libraryReady` is that session flag.
 */
type Step = 'library' | 'adjust' | 'filter' | 'share' | 'music' | 'tag';

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

function deleteQuietly(uris: string[]) {
  for (const uri of uris) {
    try {
      new File(uri).delete();
    } catch {
      // Already gone. Nothing to do.
    }
  }
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
  /** True from the moment the library is allowed to show until the session ends. */
  const [libraryReady, setLibraryReady] = useState(false);
  const [rawPicked, setRawPicked] = useState<RawPick | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [filterName, setFilterName] = useState(FILTERS[0].name);
  const [caption, setCaption] = useState('');
  const [musicTrack, setMusicTrack] = useState<Track | null>(null);
  const [musicStartMs, setMusicStartMs] = useState(0);
  const [tags, setTags] = useState<PostTag[]>([]);
  const [posting, setPosting] = useState(false);
  /**
   * Set when a permission was refused, so there's something to retry from.
   * `canAskAgain` decides what "retry" means: iOS only ever shows the
   * permission dialog once, so after a refusal the only real fix is the
   * Settings app -- re-requesting returns denied instantly and, before this
   * was tracked, "Try again" just flashed and landed back on the same screen.
   */
  const [blocked, setBlocked] = useState<{ message: string; canAskAgain: boolean } | null>(null);
  /**
   * True while a selection is being turned into the next step -- resolving a
   * library asset's real file, or downscaling a locked-in crop into the
   * filter step's preview. Shown as a spinner in place of "Next" rather than
   * a separate blank screen, so it never reads as the app having reset.
   */
  const [processing, setProcessing] = useState(false);

  const { stop: stopMusic } = useMusic();
  // Who can be tagged: the people you follow, same set the comment
  // composer's @mention typeahead offers.
  const { data: following } = useFollowList(session?.user.id, 'following');

  const cropRef = useRef<CropAdjustHandle>(null);
  const postingRef = useRef(false);

  const filter = getFilter(filterName) ?? FILTERS[0];
  const isNormal = filter.name === 'Normal';

  // One decode per session for each of the two preview copies. Both are
  // null until Skia has them, at which point every FilterPreview and the
  // strip switch from empty to drawn together; switching between the
  // filter, share and music steps afterwards costs nothing.
  const previewImage = useImage(picked?.previewUri ?? null);
  const thumbImage = useImage(picked?.thumbUri ?? null);

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
  const libraryReadyRef = useRef(libraryReady);
  const blockedRef = useRef(blocked);
  const pickedRef = useRef(picked);
  useEffect(() => {
    libraryReadyRef.current = libraryReady;
    blockedRef.current = blocked;
    pickedRef.current = picked;
  }, [libraryReady, blocked, picked]);

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
        setBlocked({
          message: permission.canAskAgain
            ? 'Kalos needs photo library access to post.'
            : 'Kalos needs photo library access to post. Turn it on in Settings, then come back.',
          canAskAgain: permission.canAskAgain,
        });
        return;
      }
      setLibraryReady(true);
      setStep('library');
    } finally {
      picking.current = false;
    }
  }, []);

  // Coming back from Settings with access granted should just open the
  // library -- not wait for another tap on a button that says "Try again"
  // for a thing that's already been fixed.
  useEffect(() => {
    if (!blocked) return;
    const sub = AppState.addEventListener('change', (status) => {
      if (status !== 'active') return;
      MediaLibrary.getPermissionsAsync()
        .then((p) => {
          if (p.granted) void launch();
        })
        .catch(() => undefined);
    });
    return () => sub.remove();
  }, [blocked, launch]);

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
      // Into the camera roll, the way 2015 Instagram saved originals by
      // default. launchCameraAsync writes only to the app's cache, so before
      // this a shot was gone for good the moment you tapped Back on the
      // crop step -- no confirmation, nothing to recover. Saved, it also
      // shows up at the top of the grid (the picker listens for library
      // changes), so Back lands you on it. Best-effort: a failed save just
      // means the old, in-memory-only behaviour.
      let assetId = asset.uri;
      try {
        const saved = await MediaLibrary.createAssetAsync(asset.uri);
        assetId = saved.id;
      } catch {
        // Limited access or a write refusal; carry on with the cache copy.
      }
      setRawPicked({ uri: asset.uri, width: asset.width, height: asset.height, assetId });
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
      // event. A live session (the library up, or a photo in hand) means
      // there is nothing to launch.
      if (blockedRef.current || libraryReadyRef.current || pickedRef.current) {
        return;
      }
      void launch();
    }, [launch])
  );

  // The music step's audition only stopped on Back/Done/discard/share or when
  // MusicPicker unmounted -- and this tab never unmounts. Leaving it any other
  // way (a tapped push notification, Android's hardware back, another tab)
  // kept the track looping under whatever screen came next, and a feed post
  // with no music of its own had nothing to replace it with. Blur is the one
  // event every exit shares.
  useFocusEffect(
    useCallback(() => {
      return () => stopMusic();
    }, [stopMusic])
  );

  /** Everything back to a cold composer. The session's cache files go with it. */
  const resetSession = useCallback(
    (keepFiles: boolean) => {
      const current = pickedRef.current;
      if (current && !keepFiles) {
        deleteQuietly([current.uri, current.previewUri, current.thumbUri]);
      }
      // 'filter', not 'library' -- same reasoning as the initial state above.
      // If this component doesn't fully unmount before the tab's focused
      // again, a stale 'library'/'adjust' step would skip launch() entirely and
      // leave the composer sitting on the last post's leftovers.
      setStep('filter');
      setLibraryReady(false);
      setRawPicked(null);
      setPicked(null);
      setFilterName(FILTERS[0].name);
      setCaption('');
      setMusicTrack(null);
      setMusicStartMs(0);
      setTags([]);
      stopMusic();
    },
    [stopMusic]
  );

  const discard = useCallback(() => {
    resetSession(false);
    router.replace('/(tabs)');
  }, [resetSession, router]);

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
   * Three files come out of it: the capped source the bake reads, the preview
   * the filter step shows, and the tiny copy the filter strip draws its 18
   * tiles from. They're the same pixels by construction, so the filter you
   * pick and the thumbnail beside the caption match what actually gets
   * uploaded.
   *
   * Shared by both entry points. The library picker and the camera's adjust
   * step arrive here with exactly the same things -- a file, its true
   * dimensions, a rect in that file's pixel space, and which asset it was --
   * so there is one place where a crop turns into a post, not two that have
   * to agree.
   *
   * The filter resets only when the *photo* changes; the caption never does.
   * Going Back to the library and Next again on the same photo used to wipe
   * both, which made "let me just check one thing" cost you your caption.
   */
  const prepareFramed = useCallback(
    async ({
      uri,
      natural,
      crop,
      assetId,
    }: {
      uri: string;
      natural: ImageSize;
      crop: CropRect;
      assetId: string;
    }) => {
      setProcessing(true);
      try {
        const { source, preview } = await prepareSource(uri, crop, natural, PREVIEW_MAX_EDGE);
        const thumb = await downscaleForPreview(preview.uri, THUMB_SOURCE_EDGE);
        const previous = pickedRef.current;
        if (previous) {
          deleteQuietly([previous.uri, previous.previewUri, previous.thumbUri]);
          if (previous.assetId !== assetId) setFilterName(FILTERS[0].name);
        }
        setPicked({
          uri: source.uri,
          width: source.width,
          height: source.height,
          previewUri: preview.uri,
          thumbUri: thumb.uri,
          assetId,
        });
        // The caption survives a re-crop; tags can't. Their coordinates
        // describe where a person was in the *old* framing.
        setTags([]);
        setRawPicked(null);
        setStep('filter');
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
    await prepareFramed({
      uri: rawPicked.uri,
      natural,
      crop: cropRef.current.getCrop(natural),
      assetId: rawPicked.assetId,
    });
  }, [rawPicked, prepareFramed]);

  /**
   * Share hands the post to lib/postUpload and gets out of the way. For an
   * ordinary post that means: reset, back to the feed, and the upload shows
   * itself as a banner there (components/PostingBanner) -- the way 2015
   * Instagram did it, so posting feels instant rather than like a several-
   * second modal. The forced first post is the one exception: there is no
   * feed to return to yet, and app/_layout.tsx's redirect reads post_count
   * off AuthProvider's profile, so this screen waits for the insert and the
   * profile refresh before leaving -- otherwise the redirect saw the stale
   * post_count === 0, replaced straight back here, and the focus handler
   * reopened the library over the feed the user was expecting.
   */
  const share = useCallback(async () => {
    if (!picked || !session) return;
    // `disabled={posting}` relies on a re-render landing before the next tap,
    // which is exactly what a busy JS thread can't promise. A ref flips
    // synchronously, so a double tap can't start a second upload of the
    // same photo.
    if (postingRef.current) return;
    postingRef.current = true;
    setPosting(true);

    const job = {
      userId: session.user.id,
      sourceUri: picked.uri,
      previewUri: picked.previewUri,
      filter,
      caption: caption.trim() || null,
      music: musicTrack ? trackToPostMusic(musicTrack, musicStartMs) : null,
      tags,
      tempFiles: [picked.uri, picked.previewUri, picked.thumbUri],
      onSuccess: async () => {
        qc.invalidateQueries({ queryKey: ['home_feed'] });
        qc.invalidateQueries({ queryKey: ['profile-posts'] });
        qc.invalidateQueries({ queryKey: ['profile'] });
        qc.invalidateQueries({ queryKey: ['posted-today'] });
        // Best-effort: a failure here must never read as "could not post"
        // (it already did). If the flag flip fails, refreshProfile() still
        // picks up the real post_count from the DB, and the redirect only
        // re-forces this screen while post_count is 0 -- so a failed flip
        // alone can't strand anyone here, it just retries next time.
        if (isForcedFirstPost) {
          try {
            await updateProfile.mutateAsync({ onboarded: true });
          } catch (e) {
            console.warn('onboarding flag flip failed, will self-heal on next post', e);
          }
        }
        // AuthProvider's profile is separate state from the react-query
        // cache -- the redirect in app/_layout.tsx reads post_count and
        // onboarded off of it, so it needs its own explicit refresh.
        await refreshProfile();
      },
    };

    if (isForcedFirstPost) {
      const result = await startPost(job, { blocking: true });
      postingRef.current = false;
      setPosting(false);
      if (!result.ok) {
        // Name the stage that actually failed. "Could not post" plus a bare
        // message is unactionable when the pipeline is bake -> 2 uploads ->
        // insert and any of the four can throw.
        Alert.alert(`Could not post (${result.stage})`, result.message);
        return;
      }
      resetSession(true);
      router.replace('/(tabs)');
      return;
    }

    // The slot may still be busy with the previous post. Say so and keep
    // everything -- the photo, the caption -- so a second tap in a moment
    // just works.
    const slot = getPostUploadState();
    if (slot.status !== 'idle') {
      postingRef.current = false;
      setPosting(false);
      Alert.alert(
        'Hold on',
        slot.status === 'posting'
          ? 'Your last photo is still posting. Try again in a moment.'
          : 'Your last photo didn’t post. Retry or discard it from the feed first.'
      );
      return;
    }

    // Fire and forget: from here the banner on the feed owns the outcome.
    void startPost(job);
    postingRef.current = false;
    setPosting(false);
    resetSession(true);
    router.replace('/(tabs)');
  }, [
    picked,
    session,
    filter,
    caption,
    musicTrack,
    musicStartMs,
    tags,
    qc,
    router,
    isForcedFirstPost,
    updateProfile,
    refreshProfile,
    resetSession,
  ]);

  // The composer is a flow, not a destination: once you're in it every screen
  // has its own Cancel, and the tab bar underneath is either a way to abandon
  // a half-written post without being asked or -- during a forced first post
  // -- a row of buttons with nowhere to go. Instagram's composer covers it for
  // the same reason. Scoped to this screen by React Navigation, so it comes
  // back on its own the moment the composer is left.
  const hideTabBar = <Tabs.Screen options={{ tabBarStyle: { display: 'none' } }} />;

  // The picker owns the whole screen, header included -- it has a preview,
  // an album switcher and a camera button to place, and splitting that
  // chrome across two files is how the header ends up disagreeing with what
  // the screen underneath it can actually do. It stays mounted underneath
  // every later step (see the Step doc comment); `covered` just keeps it
  // from taking touches while something is drawn over it.
  const covered = step !== 'library';
  const libraryLayer = libraryReady ? (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents={covered ? 'none' : 'auto'}
      accessibilityElementsHidden={covered}
      importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
    >
      <LibraryPicker
        onCancel={discard}
        canCancel={!isForcedFirstPost}
        onOpenCamera={openCamera}
        onNext={prepareFramed}
      />
    </View>
  ) : null;

  let screen: React.ReactNode = null;

  if (step === 'library') {
    screen = null;
  } else if (step === 'adjust' && rawPicked) {
    const frame = { width: SCREEN, height: SCREEN / frameAspectRatio };
    screen = (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          {/* Back to the picker, not out of the composer: the camera is a
              detour from the library, so undoing the shot should return you
              to where you took it from. The shot itself is already in the
              camera roll (see openCamera). */}
          <Pressable
            onPress={() => {
              setRawPicked(null);
              setStep('library');
            }}
            hitSlop={12}
            disabled={processing}
            accessibilityRole="button"
            accessibilityState={{ disabled: processing }}
          >
            <Text style={[styles.headerAction, { color: colors.text }, processing && styles.disabled]}>
              Back
            </Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>New post</Text>
          <Pressable
            onPress={confirmCrop}
            hitSlop={12}
            disabled={processing}
            accessibilityRole="button"
            accessibilityLabel={processing ? 'Preparing photo' : 'Next'}
            accessibilityState={{ disabled: processing }}
          >
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
            // actual crop math.
            onImageLoad={(size) => setRawPicked((prev) => (prev ? { ...prev, ...size } : prev))}
          />
        </View>
      </SafeAreaView>
    );
  } else if (!picked) {
    // Bare while the native camera/permission sheet is up -- anything drawn
    // here would flash for the moment before it covers the screen.
    screen = (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
        {blocked ? (
          <>
            <View style={[styles.header, { borderBottomColor: colors.border }]}>
              {/* The tab bar is hidden on every composer screen, so without
                  this there was no way out of a refused permission short of
                  force-quitting the app. During a forced first post Cancel
                  can't actually leave (the redirect brings the composer
                  straight back), so it's not offered there -- Settings is
                  the only real exit, and the effect above takes it from
                  there the moment access is granted. */}
              {isForcedFirstPost ? (
                <View style={styles.headerSpacer} />
              ) : (
                <Pressable onPress={discard} hitSlop={12} accessibilityRole="button">
                  <Text style={[styles.headerAction, { color: colors.text }]}>Cancel</Text>
                </Pressable>
              )}
              <Text style={[styles.title, { color: colors.text }]}>New post</Text>
              <View style={styles.headerSpacer} />
            </View>
            <EmptyState
              icon="camera-off"
              title="Can't open that"
              body={blocked.message}
              actionLabel={blocked.canAskAgain ? 'Try again' : 'Open Settings'}
              onAction={
                blocked.canAskAgain ? launch : () => Linking.openSettings().catch(() => undefined)
              }
            />
          </>
        ) : null}
      </SafeAreaView>
    );
  } else if (step === 'filter') {
    screen = (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          {/* Back to the picker rather than out of the composer -- changing
              your mind about which photo shouldn't cost you the whole post,
              and every step from here on is already reversible. */}
          <Pressable onPress={() => setStep('library')} hitSlop={12} accessibilityRole="button">
            <Text style={[styles.headerAction, { color: colors.text }]}>Back</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>New post</Text>
          <Pressable onPress={() => setStep('share')} hitSlop={12} accessibilityRole="button">
            <Text style={[styles.headerAction, styles.forward, { color: colors.accent }]}>Next</Text>
          </Pressable>
        </View>

        <ScrollView keyboardShouldPersistTaps="handled">
          <FilterPreview
            image={previewImage}
            filter={filter}
            strength={1}
            size={{ width: SCREEN, height: SCREEN / previewAspectRatio }}
            style={styles.preview}
          />

          <FilterStrip
            image={thumbImage}
            selectedFilterName={filterName}
            thumbSize={84}
            onSelect={setFilterName}
          />
        </ScrollView>
      </SafeAreaView>
    );
  } else if (step === 'music') {
    screen = (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top', 'bottom']}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable
            onPress={() => {
              stopMusic();
              setStep('share');
            }}
            hitSlop={12}
            accessibilityRole="button"
          >
            <Text style={[styles.headerAction, { color: colors.text }]}>Back</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Add music</Text>
          <Pressable
            onPress={() => {
              stopMusic();
              setStep('share');
            }}
            hitSlop={12}
            accessibilityRole="button"
          >
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
  } else if (step === 'tag') {
    screen = (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top', 'bottom']}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={() => setStep('share')} hitSlop={12} accessibilityRole="button">
            <Text style={[styles.headerAction, { color: colors.text }]}>Back</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Tag people</Text>
          <Pressable onPress={() => setStep('share')} hitSlop={12} accessibilityRole="button">
            <Text style={[styles.headerAction, styles.forward, { color: colors.accent }]}>Done</Text>
          </Pressable>
        </View>

        <TagPeopleEditor
          image={previewImage}
          filter={filter}
          // previewAspectRatio, not frameAspectRatio: the photo here is the
          // already-cropped one, and this is the same size the filter step
          // draws it at -- which is what makes a tap's fraction line up with
          // where PostCard puts the bubble later.
          frame={{ width: SCREEN, height: SCREEN / previewAspectRatio }}
          tags={tags}
          onChangeTags={setTags}
          candidates={following ?? []}
        />
      </SafeAreaView>
    );
  } else {
    screen = (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top', 'bottom']}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable
            onPress={() => setStep('filter')}
            hitSlop={12}
            disabled={posting}
            accessibilityRole="button"
            accessibilityState={{ disabled: posting }}
          >
            <Text style={[styles.headerAction, { color: colors.text }, posting && styles.disabled]}>
              Back
            </Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>New post</Text>
          <Pressable
            onPress={share}
            hitSlop={12}
            disabled={posting}
            accessibilityRole="button"
            accessibilityLabel={posting ? 'Posting' : 'Share'}
            accessibilityState={{ disabled: posting }}
          >
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
              image={previewImage}
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
              // share() captures the caption at tap time; anything typed
              // after that would be silently dropped.
              editable={!posting}
            />
          </View>
          <Pressable
            onPress={() => setStep('tag')}
            disabled={posting}
            style={[styles.optionRow, { borderTopColor: colors.border }]}
            accessibilityRole="button"
            accessibilityLabel={tags.length ? 'Edit tagged people' : 'Tag people'}
          >
            <Ionicons name="person-outline" size={18} color={colors.text} />
            <Text style={[styles.optionLabel, { color: colors.text }]} numberOfLines={1}>
              {tags.length === 0
                ? 'Tag people'
                : tags.length === 1
                  ? tags[0].username
                  : `${tags.length} people`}
            </Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </Pressable>
          <Pressable
            onPress={() => setStep('music')}
            disabled={posting}
            style={[styles.optionRow, { borderTopColor: colors.border }]}
            accessibilityRole="button"
            accessibilityLabel={musicTrack ? 'Change music' : 'Add music'}
          >
            <Ionicons name="musical-notes-outline" size={18} color={colors.text} />
            <Text style={[styles.optionLabel, { color: colors.text }]} numberOfLines={1}>
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

  return (
    <View style={[styles.root, { backgroundColor: colors.surface }]}>
      {hideTabBar}
      {libraryLayer}
      {screen ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface }]}>{screen}</View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
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
  // Balances a lone header action so the title stays centred under
  // space-between; sized to roughly what "Cancel" takes up.
  headerSpacer: { width: 48 },
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
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  optionLabel: { flex: 1, fontSize: 15 },
  appliedFilter: {
    paddingHorizontal: 16,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
});
