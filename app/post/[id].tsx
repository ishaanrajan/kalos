import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PostCard } from '../../components/PostCard';
import { CommentRow } from '../../components/CommentRow';
import { EmptyState } from '../../components/EmptyState';
import { useAddComment, useComments, useDeletePost, usePost, useToggleLike } from '../../lib/queries';
import { avatarUrl, photoUrl } from '../../lib/supabase';
import { useUserId } from '../../lib/auth';
import { confirmDestructive } from '../../lib/actionSheet';
import { useTheme } from '../../lib/theme';

export default function PostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const userId = useUserId();
  const { data: post, isLoading } = usePost(id);
  const { data: comments } = useComments(id);
  const addComment = useAddComment(id!);
  const toggleLike = useToggleLike();
  const deletePost = useDeletePost();
  const [draft, setDraft] = useState('');
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  if (isLoading || !post) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        {isLoading ? (
          <ActivityIndicator />
        ) : (
          <EmptyState icon="image" title="Post not found" body="It may have been deleted." />
        )}
      </View>
    );
  }

  function submit() {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    addComment.mutate(body, {
      onError: (e) => {
        // Give the typed comment back instead of silently losing it.
        setDraft(body);
        Alert.alert('Could not post comment', e instanceof Error ? e.message : undefined);
      },
    });
  }

  function deleteThisPost() {
    confirmDestructive('Delete post?', 'Delete Post', () => {
      deletePost.mutate(
        { id: post!.id, image_path: post!.image_path },
        {
          onSuccess: () => router.back(),
          onError: (e) => Alert.alert('Could not delete post', e instanceof Error ? e.message : undefined),
        }
      );
    });
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      // See the same fix in app/dm/[username].tsx -- 90 was a hardcoded
      // guess at the native header's height, wrong on devices whose
      // safe-area-top differs (Dynamic Island vs. notch vs. none).
      keyboardVerticalOffset={insets.top + 44}
    >
      <FlatList
        data={comments ?? []}
        keyExtractor={(c) => c.id}
        ListHeaderComponent={
          <PostCard
            post={{
              ...post,
              author_username: post.author.username,
              author_display_name: post.author.display_name,
              author_avatar_path: post.author.avatar_path,
            }}
            imageUrl={photoUrl(post.image_path)}
            avatarUrl={avatarUrl(post.author.avatar_path)}
            onLike={() =>
              toggleLike.mutate(
                { postId: post.id, liked: post.viewer_has_liked },
                {
                  onError: (e) =>
                    Alert.alert('Could not update like', e instanceof Error ? e.message : undefined),
                }
              )
            }
            onPressAuthor={() => router.push(`/profile/${post.author.username}`)}
            onPressLikes={() => router.push(`/likes/${post.id}`)}
            onPressOptions={post.author.id === userId ? deleteThisPost : undefined}
            showCommentPreview={false}
          />
        }
        renderItem={({ item }) => (
          <CommentRow
            comment={item}
            avatarUrl={avatarUrl(item.author?.avatar_path ?? null)}
            onPressAuthor={() => item.author && router.push(`/profile/${item.author.username}`)}
          />
        )}
      />

      <View
        style={[
          styles.composer,
          { paddingBottom: Math.max(10, insets.bottom), borderTopColor: colors.border },
        ]}
      >
        <TextInput
          style={[styles.input, { color: colors.text }]}
          placeholder="Add a comment…"
          placeholderTextColor={colors.textSecondary}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          returnKeyType="send"
        />
        <Pressable onPress={submit} disabled={!draft.trim() || addComment.isPending} hitSlop={10}>
          <Text style={[styles.post, { color: colors.accent }, !draft.trim() && styles.postDisabled]}>
            Post
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, fontSize: 14, paddingVertical: 6 },
  post: { fontWeight: '600', fontSize: 14 },
  postDisabled: { opacity: 0.4 },
});
