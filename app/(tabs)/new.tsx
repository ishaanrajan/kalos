import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { FilterStrip } from '../../components/FilterStrip';
import { FilterPreview } from '../../components/FilterPreview';
import { EmptyState } from '../../components/EmptyState';
import { FILTERS, getFilter } from '../../lib/filters';
import { bakeFilteredImage, downscaleForPreview } from '../../lib/bake';
import { supabase, PHOTOS_BUCKET } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';

const SCREEN = Dimensions.get('window').width;

type Picked = { uri: string; previewUri: string; width: number; height: number };

/**
 * Two steps, the way the app this imitates did it: choose the look, then write
 * the caption.
 */
type Step = 'filter' | 'share';

type Source = 'camera' | 'library';

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
  const { session } = useAuth();

  const [picked, setPicked] = useState<Picked | null>(null);
  const [step, setStep] = useState<Step>('filter');
  const [filterName, setFilterName] = useState(FILTERS[0].name);
  const [caption, setCaption] = useState('');
  const [posting, setPosting] = useState(false);
  /** Set when a permission was refused, so there's something to retry from. */
  const [blocked, setBlocked] = useState<string | null>(null);

  const filter = getFilter(filterName) ?? FILTERS[0];
  const isNormal = filter.name === 'Normal';

  /** Guards the focus effect against re-entering while a picker is already up. */
  const picking = useRef(false);

  // useFocusEffect re-invokes its callback whenever the callback's identity
  // changes while the screen is still focused, not just on real navigation
  // transitions. Closing over `picked`/`blocked` directly meant clearing them
  // after a successful post (still on this screen, mid-navigate-away) looked
  // identical to a fresh focus and relaunched the picker. Refs keep the
  // callback identity stable so only genuine focus events trigger it.
  const pickedRef = useRef(picked);
  const blockedRef = useRef(blocked);
  useEffect(() => {
    pickedRef.current = picked;
    blockedRef.current = blocked;
  }, [picked, blocked]);

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

      const permission =
        source === 'camera'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setBlocked(
          source === 'camera'
            ? 'Kalos needs camera access to take a photo.'
            : 'Kalos needs photo library access to post.'
        );
        return;
      }

      const options: ImagePicker.ImagePickerOptions = {
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1], // square-first, the way it was
        quality: 1,
      };
      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync(options)
          : await ImagePicker.launchImageLibraryAsync(options);

      if (result.canceled || !result.assets[0]) {
        router.replace('/(tabs)');
        return;
      }

      const asset = result.assets[0];
      // Previews and thumbnails run against a small copy; the full-resolution
      // image is only touched once, at post time.
      const preview = await downscaleForPreview(asset.uri, 600);
      setPicked({
        uri: asset.uri,
        previewUri: preview.uri,
        width: asset.width,
        height: asset.height,
      });
      setStep('filter');
      setFilterName(FILTERS[0].name);
      setCaption('');
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
      if (!pickedRef.current && !blockedRef.current) void launch();
    }, [launch])
  );

  const discard = useCallback(() => {
    setPicked(null);
    setCaption('');
    router.replace('/(tabs)');
  }, [router]);

  const share = useCallback(async () => {
    if (!picked || !session) return;
    setPosting(true);
    try {
      const baked = await bakeFilteredImage({
        uri: picked.uri,
        filter,
        strength: 1,
        maxEdge: 1440,
      });

      const path = `${session.user.id}/${randomUUID()}.jpg`;
      const bytes = await new File(baked.uri).bytes();

      const { error: uploadError } = await supabase.storage
        .from(PHOTOS_BUCKET)
        .upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
      if (uploadError) throw uploadError;

      const { error: insertError } = await supabase.from('posts').insert({
        author_id: session.user.id,
        image_path: path,
        width: baked.width,
        height: baked.height,
        caption: caption.trim() || null,
        filter_name: isNormal ? null : filter.name,
      });
      if (insertError) throw insertError;

      qc.invalidateQueries({ queryKey: ['home_feed'] });
      qc.invalidateQueries({ queryKey: ['profile-posts'] });
      qc.invalidateQueries({ queryKey: ['profile'] });

      setPicked(null);
      setCaption('');
      router.replace('/(tabs)');
    } catch (e) {
      Alert.alert('Could not post', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setPosting(false);
    }
  }, [picked, session, filter, isNormal, caption, qc, router]);

  if (!picked) {
    // Nothing but a bare screen while the sheet and picker are up — anything
    // drawn here would flash for the moment before they cover it.
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        {blocked ? (
          <>
            <View style={styles.header}>
              <Text style={styles.title}>New post</Text>
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
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.header}>
          <Pressable onPress={discard} hitSlop={12}>
            <Text style={styles.headerAction}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>New post</Text>
          <Pressable onPress={() => setStep('share')} hitSlop={12}>
            <Text style={[styles.headerAction, styles.forward]}>Next</Text>
          </Pressable>
        </View>

        <ScrollView keyboardShouldPersistTaps="handled">
          <FilterPreview
            uri={picked.previewUri}
            filter={filter}
            strength={1}
            size={SCREEN}
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
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => setStep('filter')} hitSlop={12} disabled={posting}>
          <Text style={[styles.headerAction, posting && styles.disabled]}>Back</Text>
        </Pressable>
        <Text style={styles.title}>New post</Text>
        <Pressable onPress={share} hitSlop={12} disabled={posting}>
          {posting ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text style={[styles.headerAction, styles.forward]}>Share</Text>
          )}
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={styles.shareBody}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.captionRow}>
          <FilterPreview
            uri={picked.previewUri}
            filter={filter}
            strength={1}
            size={72}
            style={styles.thumb}
          />
          <TextInput
            style={styles.caption}
            placeholder="Write a caption…"
            placeholderTextColor="#8e8e8e"
            value={caption}
            onChangeText={setCaption}
            multiline
            autoFocus
            maxLength={2200}
          />
        </View>
        {!isNormal && <Text style={styles.appliedFilter}>{filter.name}</Text>}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  header: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#dbdbdb',
  },
  title: { fontSize: 17, fontWeight: '600', color: '#262626' },
  headerAction: { fontSize: 15, color: '#262626' },
  forward: { fontWeight: '600', color: '#3897f0' },
  disabled: { opacity: 0.4 },
  preview: { backgroundColor: '#000' },
  shareBody: { flex: 1 },
  captionRow: { flexDirection: 'row', gap: 12, padding: 16 },
  thumb: { borderRadius: 3, overflow: 'hidden', backgroundColor: '#efefef' },
  caption: { flex: 1, fontSize: 15, color: '#262626', paddingTop: 2, minHeight: 72 },
  appliedFilter: {
    paddingHorizontal: 16,
    fontSize: 12,
    color: '#8e8e8e',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
});
