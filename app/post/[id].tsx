import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
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
import { MentionSuggestions } from '../../components/MentionSuggestions';
import { useAddComment, useComments, useDeletePost, useFollowList, usePost, useToggleLike } from '../../lib/queries';
import { avatarUrl, photoUrl } from '../../lib/supabase';
import { useUserId } from '../../lib/auth';
import { confirmDestructive, showActionSheet } from '../../lib/actionSheet';
import { activeMentionQuery, applyMentionSelection } from '../../lib/mentions';
import { nativeHeaderHeight, useTheme } from '../../lib/theme';
import type { Comment } from '../../lib/types';

export default function PostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const userId = useUserId();
  const { data: post, isLoading } = usePost(id);
  const { data: comments } = useComments(id);
  const addComment = useAddComment(id!);
  const toggleLike = useToggleLike();
  const deletePost = useDeletePost();
  const { data: following } = useFollowList(userId ?? undefined, 'following');
  const [draft, setDraft] = useState('');
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const listRef = useRef<FlatList<Comment>>(null);
  const mentionQuery = useMemo(() => activeMentionQuery(draft), [draft]);

  function selectMention(username: string) {
    setDraft((prev) => applyMentionSelection(prev, username));
  }

  // FlatList.scrollToEnd() resolves the end of the list from its own
  // measured-cell bookkeeping -- with zero comments there are no cells to
  // measure, so it doesn't reliably land at the true bottom of the header
  // content (the post itself). scrollToOffset with a deliberately oversized
  // offset sidesteps that: native scroll views clamp any offset to the real
  // scrollable max automatically, so this always lands at the true end
  // whether there are 0 comments or 500.
  function scrollToBottom(animated: boolean) {
    listRef.current?.scrollToOffset({ offset: Number.MAX_SAFE_INTEGER, animated });
  }

  // Tapping the comment box focuses it well before the keyboard has actually
  // finished sliding up -- scrolling on focus lands at what's currently the
  // bottom, then the keyboard's own show animation shrinks the list's
  // visible area a moment later and covers it again. Waiting for the
  // keyboard to actually be up guarantees the scroll happens against the
  // final, already-shrunk layout instead of racing it.
  useEffect(() => {
    // "Did," not "will" -- "will" fires as the animation starts, which is
    // the same race as onFocus, just a smaller window. "Did" only fires
    // once the keyboard (and the resize it drives) has actually finished.
    const sub = Keyboard.addListener('keyboardDidShow', () => scrollToBottom(true));
    return () => sub.remove();
  }, []);

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

  function showPostOptions() {
    showActionSheet('Post options', [
      { label: 'Edit Caption', onPress: () => router.push(`/edit-caption/${post!.id}`) },
      { label: 'Delete Post', destructive: true, onPress: deleteThisPost },
    ]);
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      // See the same fix in app/dm/[username].tsx. `nativeHeaderHeight` is
      // the header's own content height (44 iOS / 56 Android) -- insets.top
      // alone is only the status bar/notch, wrong on devices whose
      // safe-area-top differs (Dynamic Island vs. notch vs. none), and using
      // iOS's 44 on Android under-offsets against its taller Material bar.
      keyboardVerticalOffset={insets.top + nativeHeaderHeight}
    >
      <FlatList
        ref={listRef}
        data={comments ?? []}
        keyExtractor={(c) => c.id}
        // Comments are oldest-first, so "the bottom" is the newest ones --
        // without this you land on the top of a long thread instead of the
        // recent activity you actually opened the screen to see or reply to.
        onContentSizeChange={() => scrollToBottom(false)}
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
            onPressOptions={post.author.id === userId ? showPostOptions : undefined}
            onPressMention={(username) => router.push(`/profile/${username}`)}
            showCommentPreview={false}
          />
        }
        renderItem={({ item }) => (
          <CommentRow
            comment={item}
            avatarUrl={avatarUrl(item.author?.avatar_path ?? null)}
            onPressAuthor={() => item.author && router.push(`/profile/${item.author.username}`)}
            onPressMention={(username) => router.push(`/profile/${username}`)}
          />
        )}
      />

      {mentionQuery !== null ? (
        <MentionSuggestions query={mentionQuery} candidates={following ?? []} onSelect={selectMention} />
      ) : null}

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
