import { useCallback, useRef, useState } from 'react';
import {
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
import Slider from '@react-native-community/slider';
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
 * the caption. Keeping them apart means the filter strip isn't competing with a
 * keyboard, and the photo gets the whole screen while you're judging it.
 */
type Step = 'filter' | 'share';

export default function NewPost() {
  const router = useRouter();
  const qc = useQueryClient();
  const { session } = useAuth();

  const [picked, setPicked] = useState<Picked | null>(null);
  const [step, setStep] = useState<Step>('filter');
  const [filterName, setFilterName] = useState(FILTERS[0].name);
  const [strength, setStrength] = useState(1);
  const [caption, setCaption] = useState('');
  const [posting, setPosting] = useState(false);

  const filter = getFilter(filterName) ?? FILTERS[0];
  const isNormal = filter.name === 'Normal';

  /** Guards against the focus effect re-entering while the picker is already up. */
  const picking = useRef(false);

  const pick = useCallback(async () => {
    if (picking.current) return;
    picking.current = true;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Photos access needed', 'Kalos needs access to your photo library to post.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1], // square-first, the way it was
        quality: 1,
      });
      if (result.canceled || !result.assets[0]) {
        // Backing out of the picker means backing out of posting.
        router.replace('/(tabs)');
        return;
      }

      const asset = result.assets[0];
      // Filter previews run against a small copy so dragging the strength slider
      // stays smooth; the full-resolution image is only touched once, at post time.
      const preview = await downscaleForPreview(asset.uri, 600);
      setPicked({
        uri: asset.uri,
        previewUri: preview.uri,
        width: asset.width,
        height: asset.height,
      });
      setStep('filter');
      setFilterName(FILTERS[0].name);
      setStrength(1);
      setCaption('');
    } finally {
      picking.current = false;
    }
  }, [router]);

  // The tab is a shutter button, not a screen: landing on it with nothing in
  // hand opens the library straight away rather than showing a card that asks
  // you to tap once more.
  useFocusEffect(
    useCallback(() => {
      if (!picked) void pick();
    }, [picked, pick])
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
        strength,
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
  }, [picked, session, filter, isNormal, strength, caption, qc, router]);

  // Only reached when the picker was dismissed by a permission denial — the
  // cancel path navigates away instead.
  if (!picked) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.title}>New post</Text>
        </View>
        <EmptyState
          icon="image"
          title="Pick a photo"
          body="Square crop, one of eighteen filters, a caption. That's the whole thing."
          actionLabel="Choose from library"
          onAction={pick}
        />
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
            strength={strength}
            size={SCREEN}
            style={styles.preview}
          />

          {/* Always rendered, disabled on Normal. Showing it conditionally made
              the strip jump every time you selected or cleared a filter. */}
          <View style={styles.strengthRow}>
            <Text style={[styles.strengthLabel, isNormal && styles.strengthMuted]}>
              {filter.name}
            </Text>
            <Slider
              style={styles.slider}
              minimumValue={0}
              maximumValue={1}
              value={strength}
              onValueChange={setStrength}
              disabled={isNormal}
              minimumTrackTintColor={isNormal ? '#dbdbdb' : '#3897f0'}
              maximumTrackTintColor="#dbdbdb"
              thumbTintColor={isNormal ? '#dbdbdb' : undefined}
            />
            <Text style={[styles.strengthValue, isNormal && styles.strengthMuted]}>
              {isNormal ? '—' : Math.round(strength * 100)}
            </Text>
          </View>

          <FilterStrip
            uri={picked.previewUri}
            selectedFilterName={filterName}
            thumbSize={84}
            onSelect={(name) => {
              setFilterName(name);
              setStrength(1);
            }}
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
            strength={strength}
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
  strengthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  strengthLabel: { width: 78, fontSize: 13, fontWeight: '600', color: '#262626' },
  strengthMuted: { color: '#c7c7c7' },
  slider: { flex: 1 },
  strengthValue: { width: 30, textAlign: 'right', fontSize: 13, color: '#8e8e8e' },
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
