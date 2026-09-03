import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { Stack, useRouter } from 'expo-router';
import { Avatar } from '../components/Avatar';
import { downscaleForPreview } from '../lib/bake';
import { useUpdateProfile, type ProfilePatch } from '../lib/queries';
import { avatarUrl, supabase, AVATARS_BUCKET } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';

const USERNAME_RULE = /^[a-z0-9._]{3,30}$/;

export default function EditProfile() {
  const router = useRouter();
  const { profile, session, refreshProfile } = useAuth();
  const updateProfile = useUpdateProfile();
  const { colors } = useTheme();

  const [username, setUsername] = useState(profile?.username ?? '');
  const [displayName, setDisplayName] = useState(profile?.display_name ?? '');
  const [bio, setBio] = useState(profile?.bio ?? '');
  /** Local file uri while a newly picked avatar is still unsaved. */
  const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const pickAvatar = useCallback(async () => {
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
    if (!profile || !session) return;

    const nextUsername = username.trim().toLowerCase();
    if (!USERNAME_RULE.test(nextUsername)) {
      Alert.alert(
        'Pick a different username',
        'Three to thirty characters, using lowercase letters, numbers, dots and underscores.'
      );
      return;
    }

    setSaving(true);
    try {
      const patch: ProfilePatch = {
        display_name: displayName.trim() || null,
        bio: bio.trim() || null,
      };
      if (nextUsername !== profile.username) patch.username = nextUsername;

      // Avatars are small and never filtered, so this is a plain downscale and
      // upload -- no Skia bake, unlike the post pipeline.
      if (pendingAvatar) {
        const small = await downscaleForPreview(pendingAvatar, 400);
        const path = `${session.user.id}/${randomUUID()}.jpg`;
        const bytes = await new File(small.uri).bytes();
        const { error: uploadError } = await supabase.storage
          .from(AVATARS_BUCKET)
          .upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
        if (uploadError) throw uploadError;
        patch.avatar_path = path;
      }

      await updateProfile.mutateAsync(patch);
      await refreshProfile();
      router.back();
    } catch (e) {
      // citext unique index on username; 23505 is the only failure worth
      // explaining in plain language.
      const message =
        e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === '23505'
          ? `The username "${username.trim().toLowerCase()}" is taken.`
          : e instanceof Error
            ? e.message
            : 'Something went wrong.';
      Alert.alert('Could not save', message);
    } finally {
      setSaving(false);
    }
  }, [profile, session, username, displayName, bio, pendingAvatar, updateProfile, refreshProfile, router]);

  if (!profile) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen
        options={{
          title: 'Edit profile',
          headerRight: () =>
            saving ? (
              <ActivityIndicator size="small" />
            ) : (
              <Pressable onPress={save} hitSlop={12}>
                <Text style={[styles.done, { color: colors.accent }]}>Done</Text>
              </Pressable>
            ),
        }}
      />

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={styles.avatarBlock}>
          <Avatar
            url={pendingAvatar ?? avatarUrl(profile.avatar_path)}
            username={profile.username}
            size={88}
          />
          <Pressable onPress={pickAvatar} hitSlop={8}>
            <Text style={[styles.changePhoto, { color: colors.accent }]}>Change profile photo</Text>
          </Pressable>
        </View>

        <Field label="Username">
          <TextInput
            style={[styles.input, { color: colors.text }]}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={30}
            placeholder="username"
            placeholderTextColor={colors.textSecondary}
          />
        </Field>

        <Field label="Name">
          <TextInput
            style={[styles.input, { color: colors.text }]}
            value={displayName}
            onChangeText={setDisplayName}
            maxLength={60}
            placeholder="Your name"
            placeholderTextColor={colors.textSecondary}
          />
        </Field>

        <Field label="Bio">
          <TextInput
            style={[styles.input, styles.bioInput, { color: colors.text }]}
            value={bio}
            onChangeText={setBio}
            multiline
            maxLength={160}
            placeholder="Say something about yourself"
            placeholderTextColor={colors.textSecondary}
          />
        </Field>

        <Text style={[styles.counter, { color: colors.textSecondary }]}>{bio.length}/160</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.field, { borderBottomColor: colors.border }]}>
      <Text style={[styles.fieldLabel, { color: colors.text }]}>{label}</Text>
      <View style={styles.fieldControl}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingBottom: 40 },
  done: { fontSize: 15, fontWeight: '600' },
  avatarBlock: { alignItems: 'center', paddingVertical: 24, gap: 12 },
  changePhoto: { fontSize: 14, fontWeight: '600' },
  field: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fieldLabel: { width: 92, fontSize: 14, paddingTop: 10 },
  fieldControl: { flex: 1 },
  input: { fontSize: 15, paddingVertical: 10 },
  bioInput: { minHeight: 72, textAlignVertical: 'top' },
  counter: { alignSelf: 'flex-end', paddingHorizontal: 16, paddingTop: 8, fontSize: 12 },
});
