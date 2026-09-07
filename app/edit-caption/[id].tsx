import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { usePost, useUpdatePostCaption } from '../../lib/queries';
import { photoUrl } from '../../lib/supabase';
import { useUserId } from '../../lib/auth';
import { useTheme } from '../../lib/theme';

/**
 * Editing an existing post's caption -- a separate screen rather than an
 * inline edit on the post itself, matching edit-profile.tsx's own pattern
 * (Stack header with a Done button, not a save button buried in content).
 */
export default function EditCaption() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const userId = useUserId();
  const { data: post, isLoading } = usePost(id);
  const updateCaption = useUpdatePostCaption();
  const { colors } = useTheme();

  const [caption, setCaption] = useState(post?.caption ?? '');
  const [initialized, setInitialized] = useState(false);

  // usePost() resolves after this screen has already mounted, so the
  // TextInput's initial state (above) is set before the real caption is
  // known -- seed it once the post actually loads, but only once, so it
  // doesn't stomp on what the person's typed if the query ever refetches.
  if (post && !initialized) {
    setCaption(post.caption ?? '');
    setInitialized(true);
  }

  function save() {
    if (!post) return;
    const trimmed = caption.trim();
    updateCaption.mutate(
      { postId: post.id, caption: trimmed || null },
      {
        onSuccess: () => router.back(),
        onError: (e) => Alert.alert('Could not save', e instanceof Error ? e.message : undefined),
      }
    );
  }

  if (isLoading || !post) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator />
      </View>
    );
  }

  // Only the author should ever land here -- PostCard only offers this
  // option on your own posts, but the route itself has no way to know that
  // without checking, since it's reachable by URL.
  if (post.author.id !== userId) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <Text style={{ color: colors.text }}>You can only edit your own posts.</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Stack.Screen
        options={{
          title: 'Edit caption',
          headerRight: () =>
            updateCaption.isPending ? (
              <ActivityIndicator size="small" />
            ) : (
              <Pressable onPress={save} hitSlop={12}>
                <Text style={[styles.done, { color: colors.accent }]}>Done</Text>
              </Pressable>
            ),
        }}
      />

      {/* Thumbnail + caption side by side, same layout as the share step of
          new.tsx -- editing the caption shouldn't feel like a different
          screen than writing it the first time, and it keeps the actual post
          in view instead of just a bare text box. */}
      <View style={styles.captionRow}>
        <Image
          source={photoUrl(post.image_path)}
          style={[styles.thumb, { backgroundColor: colors.imagePlaceholder }]}
          contentFit="cover"
        />
        <TextInput
          style={[styles.input, { color: colors.text }]}
          value={caption}
          onChangeText={setCaption}
          multiline
          autoFocus
          maxLength={2200}
          placeholder="Write a caption…"
          placeholderTextColor={colors.textSecondary}
        />
      </View>
      <Text style={[styles.counter, { color: colors.textSecondary }]}>{caption.length}/2200</Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  done: { fontSize: 15, fontWeight: '600' },
  captionRow: { flexDirection: 'row', gap: 12, padding: 16 },
  thumb: { width: 72, height: 72, borderRadius: 3, overflow: 'hidden' },
  input: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    paddingTop: 2,
    minHeight: 72,
  },
  counter: { alignSelf: 'flex-end', paddingHorizontal: 16, paddingBottom: 16, fontSize: 12 },
});
