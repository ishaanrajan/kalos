import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
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
import { useRouter } from 'expo-router';
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

export default function NewPost() {
  const router = useRouter();
  const qc = useQueryClient();
  const { session } = useAuth();

  const [picked, setPicked] = useState<Picked | null>(null);
  const [filterName, setFilterName] = useState(FILTERS[0].name);
  const [strength, setStrength] = useState(1);
  const [caption, setCaption] = useState('');
  const [posting, setPosting] = useState(false);

  const filter = getFilter(filterName) ?? FILTERS[0];

  const pick = useCallback(async () => {
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
    if (result.canceled || !result.assets[0]) return;

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
    setFilterName(FILTERS[0].name);
    setStrength(1);
  }, []);

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
        filter_name: filter.name === 'Normal' ? null : filter.name,
      });
      if (insertError) throw insertError;

      qc.invalidateQueries({ queryKey: ['home_feed'] });
      qc.invalidateQueries({ queryKey: ['profile-posts'] });

      setPicked(null);
      setCaption('');
      router.push('/(tabs)');
    } catch (e) {
      Alert.alert('Could not post', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setPosting(false);
    }
  }, [picked, session, filter, strength, caption, qc, router]);

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

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => setPicked(null)} hitSlop={12} disabled={posting}>
          <Text style={[styles.headerAction, posting && styles.disabled]}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>New post</Text>
        <Pressable onPress={share} hitSlop={12} disabled={posting}>
          {posting ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text style={[styles.headerAction, styles.share]}>Share</Text>
          )}
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

        {filter.name !== 'Normal' && (
          <View style={styles.strengthRow}>
            <Text style={styles.strengthLabel}>{filter.name}</Text>
            <Slider
              style={styles.slider}
              minimumValue={0}
              maximumValue={1}
              value={strength}
              onValueChange={setStrength}
              minimumTrackTintColor="#3897f0"
              maximumTrackTintColor="#dbdbdb"
            />
            <Text style={styles.strengthValue}>{Math.round(strength * 100)}</Text>
          </View>
        )}

        <FilterStrip
          uri={picked.previewUri}
          selectedFilterName={filterName}
          onSelect={(name) => {
            setFilterName(name);
            setStrength(1);
          }}
        />

        <TextInput
          style={styles.caption}
          placeholder="Write a caption…"
          placeholderTextColor="#8e8e8e"
          value={caption}
          onChangeText={setCaption}
          multiline
          maxLength={2200}
        />
      </ScrollView>
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
  share: { color: '#3897f0', fontWeight: '600' },
  disabled: { opacity: 0.4 },
  preview: { width: SCREEN, height: SCREEN, backgroundColor: '#000' },
  strengthRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 10 },
  strengthLabel: { width: 74, fontSize: 12, color: '#262626', fontWeight: '600' },
  slider: { flex: 1, height: 36 },
  strengthValue: { width: 28, fontSize: 12, color: '#8e8e8e', textAlign: 'right' },
  caption: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#dbdbdb',
    padding: 16,
    fontSize: 15,
    color: '#262626',
    minHeight: 100,
    textAlignVertical: 'top',
  },
});
