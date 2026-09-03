import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Avatar } from '../components/Avatar';
import { downscaleForPreview } from '../lib/bake';
import { useUpdateProfile } from '../lib/queries';
import { supabase, AVATARS_BUCKET } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';

/**
 * Step one of forced onboarding for a new account — see app/_layout.tsx for
 * the redirect that sends someone here and won't let them leave until it's
 * done. No back button, no skip: that's the entire point.
 */
export default function OnboardingAvatar() {
  const { profile, session, refreshProfile } = useAuth();
  const updateProfile = useUpdateProfile();
  const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { colors } = useTheme();

  const pick = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Photos access needed', 'Kalos needs access to your photo library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
    });
    if (result.canceled || !result.assets[0]) return;
    setPendingAvatar(result.assets[0].uri);
  }, []);

  const save = useCallback(async () => {
    if (!pendingAvatar || !session) return;
    setSaving(true);
    try {
      const small = await downscaleForPreview(pendingAvatar, 400);
      const path = `${session.user.id}/${randomUUID()}.jpg`;
      const bytes = await new File(small.uri).bytes();
      const { error: uploadError } = await supabase.storage
        .from(AVATARS_BUCKET)
        .upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
      if (uploadError) throw uploadError;

      await updateProfile.mutateAsync({ avatar_path: path });
      await refreshProfile();
      // The redirect in app/_layout.tsx picks up the new avatar_path and
      // moves on to the forced first post — nothing to navigate to here.
    } catch (e) {
      Alert.alert('Could not save photo', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }, [pendingAvatar, session, updateProfile, refreshProfile]);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]}>
      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.text }]}>Add a profile photo</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          So people know it's really you. This is the one thing on Kalos everyone has.
        </Text>

        <Pressable onPress={pick} style={styles.avatarWrap}>
          {pendingAvatar ? (
            <Avatar url={pendingAvatar} username={profile?.username ?? ''} size={140} />
          ) : (
            <View style={[styles.placeholder, { backgroundColor: colors.surfaceAlt }]}>
              <Feather name="camera" size={32} color={colors.textSecondary} />
            </View>
          )}
          <View style={[styles.badge, { backgroundColor: colors.accent, borderColor: colors.surface }]}>
            <Feather name="edit-2" size={14} color={'#ffffff'} />
          </View>
        </Pressable>

        <Pressable onPress={pick} hitSlop={8}>
          <Text style={[styles.pickText, { color: colors.accent }]}>
            {pendingAvatar ? 'Choose a different photo' : 'Choose a photo'}
          </Text>
        </Pressable>
      </View>

      <Pressable
        style={[
          styles.continueButton,
          { backgroundColor: colors.accent },
          !pendingAvatar && styles.continueDisabled,
        ]}
        onPress={save}
        disabled={!pendingAvatar || saving}
      >
        {saving ? (
          <ActivityIndicator color={'#ffffff'} />
        ) : (
          <Text style={[styles.continueText, { color: '#ffffff' }]}>Continue</Text>
        )}
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'space-between' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  title: { fontSize: 22, fontWeight: '600', textAlign: 'center' },
  body: {
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 32,
    lineHeight: 20,
  },
  avatarWrap: { position: 'relative' },
  placeholder: {
    width: 140,
    height: 140,
    borderRadius: 70,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  pickText: { fontSize: 14, fontWeight: '600', marginTop: 20 },
  continueButton: {
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginHorizontal: 24,
    marginBottom: 24,
  },
  continueDisabled: { opacity: 0.4 },
  continueText: { fontWeight: '600', fontSize: 15 },
});
