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

  if (isLoading || !post) {
    return (
      <View style={styles.center}>
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
    addComment.mutate(body);
    setDraft('');
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
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
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
            onLike={() => toggleLike.mutate({ postId: post.id, liked: post.viewer_has_liked })}
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

      <View style={[styles.composer, { paddingBottom: Math.max(10, insets.bottom) }]}>
        <TextInput
          style={styles.input}
          placeholder="Add a comment…"
          placeholderTextColor="#8e8e8e"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          returnKeyType="send"
        />
        <Pressable onPress={submit} disabled={!draft.trim() || addComment.isPending} hitSlop={10}>
          <Text style={[styles.post, !draft.trim() && styles.postDisabled]}>Post</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#dbdbdb',
  },
  input: { flex: 1, fontSize: 14, color: '#262626', paddingVertical: 6 },
  post: { color: '#3897f0', fontWeight: '600', fontSize: 14 },
  postDisabled: { opacity: 0.4 },
});
