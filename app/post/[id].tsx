import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { PostCard } from '../../components/PostCard';
import { CommentRow } from '../../components/CommentRow';
import { EmptyState } from '../../components/EmptyState';
import { MentionSuggestions } from '../../components/MentionSuggestions';
import { GifPicker } from '../../components/GifPicker';
import {
  useAddComment,
  useAddGifComment,
  useComments,
  useDeleteComment,
  useDeletePost,
  useFollowList,
  usePost,
  useToggleLike,
} from '../../lib/queries';
import type { ProfileSummary } from '../../lib/queries';
import { avatarUrl, photoUrl } from '../../lib/supabase';
import { useUserId } from '../../lib/auth';
import { confirmDestructive, showActionSheet } from '../../lib/actionSheet';
import { activeMentionQuery, applyMentionSelection } from '../../lib/mentions';
import { nativeHeaderHeight, useTheme } from '../../lib/theme';
import * as Linking from 'expo-linking';
import { useMusic } from '../../lib/audio';
import { gifToCommentGif } from '../../lib/giphy';
import type { Gif } from '../../lib/giphy';
import type { Comment, FeedPost } from '../../lib/types';

/**
 * How close to the bottom still counts as "reading the newest comments".
 * Wide enough to survive a half-scrolled row or the rubber-band overshoot at
 * the end of a fling, narrow enough that someone who scrolled up to read the
 * caption is clearly not pinned.
 */
const BOTTOM_PIN_SLOP = 80;

/**
 * usePost() ends in `.single()`, so a post that no longer exists comes back as
 * a PostgREST error rather than as `data: null` -- this is the code it uses
 * for "the result contains 0 rows". Everything else (no network, a 500, an
 * expired token) is a transport failure that a retry can actually fix, which
 * is the distinction this screen used to get wrong: it told you a post had
 * been deleted whenever the request merely failed.
 */
const NO_ROWS = 'PGRST116';

function isMissingPostError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === NO_ROWS;
}

export default function PostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const userId = useUserId();
  const { data: post, isLoading, isError, error, refetch } = usePost(id);
  const {
    data: comments,
    isLoading: commentsLoading,
    isError: commentsError,
    refetch: refetchComments,
  } = useComments(id);
  const addComment = useAddComment(id!);
  const addGifComment = useAddGifComment(id!);
  const toggleLike = useToggleLike();
  const deletePost = useDeletePost();
  const deleteComment = useDeleteComment();
  const { data: following } = useFollowList(userId ?? undefined, 'following');
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const listRef = useRef<FlatList<Comment>>(null);

  // FlatList.scrollToEnd() resolves the end of the list from its own
  // measured-cell bookkeeping -- with zero comments there are no cells to
  // measure, so it doesn't reliably land at the true bottom of the header
  // content (the post itself). scrollToOffset with a deliberately oversized
  // offset sidesteps that: native scroll views clamp any offset to the real
  // scrollable max automatically, so this always lands at the true end
  // whether there are 0 comments or 500.
  const scrollToBottom = useCallback((animated: boolean) => {
    listRef.current?.scrollToOffset({ offset: Number.MAX_SAFE_INTEGER, animated });
  }, []);

  // onContentSizeChange fires on *any* content-size change, not just the
  // first layout: expanding a long caption ("more" in PostCard) and a new
  // comment landing both change it too. Auto-scrolling on all of them meant
  // scrolling up to read a caption and tapping "more" slammed the list back
  // to the bottom with the freshly expanded caption off-screen. So: the very
  // first change still lands you on the newest comments, and after that we
  // only follow new content when the reader is already sitting at the end.
  const didInitialScroll = useRef(false);
  const pinnedToBottom = useRef(true);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const fromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    pinnedToBottom.current = fromBottom <= BOTTOM_PIN_SLOP;
  }, []);

  const onContentSizeChange = useCallback(() => {
    if (!didInitialScroll.current) {
      didInitialScroll.current = true;
      scrollToBottom(false);
      return;
    }
    if (pinnedToBottom.current) {
      scrollToBottom(true);
    }
  }, [scrollToBottom]);

  // Tapping the comment box focuses it well before the keyboard has actually
  // finished sliding up -- scrolling on focus lands at what's currently the
  // bottom, then the keyboard's own show animation shrinks the list's
  // visible area a moment later and covers it again. Waiting for the
  // keyboard to actually be up guarantees the scroll happens against the
  // final, already-shrunk layout instead of racing it.
  //
  // Only for *this screen's* comment box. The GIF picker's search field
  // autofocuses inside its own sheet, and its keyboard fired this too --
  // scrolling the thread to the bottom behind the sheet, so closing the
  // picker without sending lost your place in a long thread.
  const composerFocused = useRef(false);
  useEffect(() => {
    // "Did," not "will" -- "will" fires as the animation starts, which is
    // the same race as onFocus, just a smaller window. "Did" only fires
    // once the keyboard (and the resize it drives) has actually finished.
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      if (composerFocused.current) scrollToBottom(true);
    });
    return () => sub.remove();
  }, [scrollToBottom]);
  const onComposerFocusChange = useCallback((focused: boolean) => {
    composerFocused.current = focused;
  }, []);

  // One identity per handler, hoisted out of the header and out of
  // renderItem: PostCard and CommentRow take the post/comment they fired on
  // so their React.memo() has stable props to compare. `.mutate` rather than
  // the mutation object, because useMutation() returns a fresh object every
  // render while `mutate` itself is a stable useCallback.
  const likePost = useCallback(
    (target: FeedPost) => {
      toggleLike.mutate(
        { postId: target.id, liked: target.viewer_has_liked },
        {
          onError: (e) =>
            Alert.alert('Could not update like', e instanceof Error ? e.message : undefined),
        }
      );
    },
    [toggleLike.mutate]
  );

  const openAuthor = useCallback(
    (target: FeedPost) => router.push(`/profile/${target.author_username}`),
    [router]
  );
  const openLikes = useCallback((target: FeedPost) => router.push(`/likes/${target.id}`), [router]);
  const openMention = useCallback(
    (username: string) => router.push(`/profile/${username}`),
    [router]
  );
  const openCommentAuthor = useCallback(
    (comment: Comment) => {
      if (comment.author) {
        router.push(`/profile/${comment.author.username}`);
      }
    },
    [router]
  );

  const deleteThisPost = useCallback(() => {
    if (!post) return;
    confirmDestructive('Delete post?', 'Delete Post', () => {
      deletePost.mutate(
        { id: post.id, image_path: post.image_path, thumb_path: post.thumb_path },
        {
          onSuccess: () => router.back(),
          onError: (e) => Alert.alert('Could not delete post', e instanceof Error ? e.message : undefined),
        }
      );
    });
  }, [post, deletePost.mutate, router]);

  // Either the comment's own author or the post's author may delete it --
  // matches comments_delete_author_or_post_owner (0004_rls.sql) exactly, so
  // this is purely about which rows get a long-press affordance at all
  // rather than a permission check the server would ever refuse.
  const canDeleteComment = useCallback(
    (comment: Comment) => comment.author_id === userId || post?.author.id === userId,
    [userId, post?.author.id]
  );

  const deleteThisComment = useCallback(
    (comment: Comment) => {
      if (!post) return;
      confirmDestructive('Delete this comment?', 'Delete', () => {
        deleteComment.mutate(
          { id: comment.id, postId: post.id },
          {
            onError: (e) =>
              Alert.alert('Could not delete comment', e instanceof Error ? e.message : undefined),
          }
        );
      });
    },
    [post, deleteComment.mutate]
  );

  const showPostOptions = useCallback(() => {
    if (!post) return;
    showActionSheet('Post options', [
      { label: 'Edit Caption', onPress: () => router.push(`/edit-caption/${post.id}`) },
      {
        label: post.music ? 'Edit Music' : 'Add Music',
        onPress: () => router.push(`/edit-music/${post.id}`),
      },
      { label: 'Delete Post', destructive: true, onPress: deleteThisPost },
    ]);
  }, [post, router, deleteThisPost]);

  const submitComment = useCallback(
    (body: string) => addComment.mutateAsync(body),
    [addComment.mutateAsync]
  );

  const submitGif = useCallback(
    (gif: Gif) => addGifComment.mutateAsync(gifToCommentGif(gif)),
    [addGifComment.mutateAsync]
  );

  // The header is an element, not a component, so an inline <PostCard /> here
  // is rebuilt on every render of this screen -- photo, gesture detector,
  // hidden caption-measurement Text and all. Memoizing the element itself
  // lets React bail out of the whole subtree when nothing about the post
  // changed, which is most renders.
  const { activePostId, muted, toggleMuted, requestPlay, stop } = useMusic();

  // The feed stops its own audio on blur, so this screen starts from silence
  // and is responsible for its own post. Playing on focus rather than on load
  // means coming back from a profile resumes the track.
  const music = post?.music ?? null;
  const postId = post?.id;
  useFocusEffect(
    useCallback(() => {
      if (postId && music) {
        requestPlay(postId, music);
      }
      return () => stop();
    }, [postId, music, requestPlay, stop]),
  );

  const openTrackStore = useCallback((p: FeedPost) => {
    // Apple licenses these previews to promote the Store, so a post that
    // plays one has to lead back to it.
    if (p.music?.store_url) Linking.openURL(p.music.store_url).catch(() => undefined);
  }, []);

  const header = useMemo(() => {
    if (!post) return null;
    return (
      <PostCard
        post={{
          ...post,
          author_username: post.author.username,
          author_display_name: post.author.display_name,
          author_avatar_path: post.author.avatar_path,
        }}
        imageUrl={photoUrl(post.image_path)}
        avatarUrl={avatarUrl(post.author.avatar_path)}
        onLike={likePost}
        onPressAuthor={openAuthor}
        onPressLikes={openLikes}
        onPressOptions={post.author.id === userId ? showPostOptions : undefined}
        onPressMention={openMention}
        showCommentPreview={false}
        isMusicActive={post.id === activePostId}
        isMusicMuted={muted}
        onToggleMusicMuted={toggleMuted}
        onPressMusic={openTrackStore}
      />
    );
  }, [
    post,
    userId,
    likePost,
    openAuthor,
    openLikes,
    openMention,
    showPostOptions,
    activePostId,
    muted,
    toggleMuted,
    openTrackStore,
  ]);

  const renderComment = useCallback(
    ({ item }: { item: Comment }) => (
      <CommentRow
        comment={item}
        avatarUrl={avatarUrl(item.author?.avatar_path ?? null)}
        onPressAuthor={openCommentAuthor}
        onPressMention={openMention}
        onLongPress={canDeleteComment(item) ? deleteThisComment : undefined}
      />
    ),
    [openCommentAuthor, openMention, canDeleteComment, deleteThisComment]
  );

  if (!post) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        {isLoading ? (
          <ActivityIndicator />
        ) : isError && !isMissingPostError(error) ? (
          <EmptyState
            icon="alert-circle"
            title="Couldn't load this post"
            body={error instanceof Error ? error.message : 'Something went wrong reaching the server.'}
            actionLabel="Try again"
            onAction={() => refetch()}
          />
        ) : (
          <EmptyState icon="image" title="Post not found" body="It may have been deleted." />
        )}
      </View>
    );
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
        onContentSizeChange={onContentSizeChange}
        onScroll={onScroll}
        // One update per frame. VirtualizedList's own default is effectively
        // "every frame" already (0.0001, because iOS no-ops a zero throttle),
        // so this is really just pinning it somewhere sane and explicit --
        // the pinned-to-bottom check needs a fresh offset, not every offset.
        scrollEventThrottle={16}
        // With the keyboard up, the first tap on a commenter's name or the
        // header's heart used to just dismiss the keyboard and go nowhere;
        // and dragging through a long thread left it covering a third of
        // the screen. MentionSuggestions and GifPicker already do both.
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        ListHeaderComponent={header}
        renderItem={renderComment}
        ListFooterComponent={
          // A thread that failed to load is not an empty thread -- this
          // used to render identically to "no comments yet". Same fix the
          // likes screen already has.
          commentsLoading ? (
            <ActivityIndicator style={styles.commentsStatus} />
          ) : commentsError ? (
            <Pressable
              onPress={() => refetchComments()}
              style={styles.commentsStatus}
              accessibilityRole="button"
              accessibilityLabel="Couldn't load comments. Tap to try again."
            >
              <Text style={[styles.commentsError, { color: colors.textSecondary }]}>
                Couldn't load comments — <Text style={{ color: colors.accent }}>Retry</Text>
              </Text>
            </Pressable>
          ) : null
        }
      />

      <CommentComposer
        candidates={following ?? []}
        isPending={addComment.isPending}
        bottomInset={Math.max(10, insets.bottom)}
        onSubmit={submitComment}
        onSubmitGif={submitGif}
        onFocusChange={onComposerFocusChange}
      />
    </KeyboardAvoidingView>
  );
}

interface CommentComposerProps {
  /** Accounts offered for an @mention -- the viewer's own follows. */
  candidates: ProfileSummary[];
  isPending: boolean;
  /** Safe-area padding under the input. */
  bottomInset: number;
  /** Rejects when the comment didn't make it, so the draft can be restored. */
  onSubmit: (body: string) => Promise<unknown>;
  /** Posts a GIF-only comment immediately -- no draft involved. */
  onSubmitGif: (gif: Gif) => Promise<unknown>;
  /** Whether the comment box itself has the keyboard (see PostScreen). */
  onFocusChange: (focused: boolean) => void;
}

/**
 * The comment box, which owns its own draft text.
 *
 * The draft used to be state on PostScreen, so every keystroke re-rendered
 * the screen: the header PostCard (photo, gesture detector, the hidden
 * caption-measurement Text) and every mounted CommentRow, because FlatList
 * hands VirtualizedList a brand-new renderItem on each render and the
 * PureComponent check in its cell renderer never bails out. Past ~60
 * comments the characters visibly lagged behind the keyboard. Down here,
 * typing re-renders exactly this component and nothing above it. The mention
 * suggestions live here too -- they're derived from the draft, so keeping
 * them with it is what makes that true.
 */
function CommentComposer({
  candidates,
  isPending,
  bottomInset,
  onSubmit,
  onSubmitGif,
  onFocusChange,
}: CommentComposerProps) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState('');
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const mentionQuery = useMemo(() => activeMentionQuery(draft), [draft]);

  const selectMention = useCallback((username: string) => {
    setDraft((prev) => applyMentionSelection(prev, username));
  }, []);

  const submit = useCallback(async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    try {
      await onSubmit(body);
    } catch (e) {
      // Give the typed comment back instead of silently losing it.
      setDraft(body);
      Alert.alert('Could not post comment', e instanceof Error ? e.message : undefined);
    }
  }, [draft, onSubmit]);

  const selectGif = useCallback(
    async (gif: Gif) => {
      // Close first, not on success -- a slow send shouldn't leave the sheet
      // sitting open over what already reads as "sent" to the person tapping.
      setGifPickerOpen(false);
      try {
        await onSubmitGif(gif);
      } catch (e) {
        Alert.alert('Could not send GIF', e instanceof Error ? e.message : undefined);
      }
    },
    [onSubmitGif]
  );

  return (
    <>
      {mentionQuery !== null ? (
        <MentionSuggestions query={mentionQuery} candidates={candidates} onSelect={selectMention} />
      ) : null}

      <View
        style={[styles.composer, { paddingBottom: bottomInset, borderTopColor: colors.border }]}
      >
        <TextInput
          style={[styles.input, { color: colors.text }]}
          placeholder="Add a comment…"
          placeholderTextColor={colors.textSecondary}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          returnKeyType="send"
        />
        {draft.trim() ? (
          <Pressable
            onPress={submit}
            disabled={isPending}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Post comment"
            accessibilityState={{ disabled: isPending }}
          >
            <Text style={[styles.post, { color: colors.accent }]}>Post</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => setGifPickerOpen(true)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Send a GIF"
          >
            <Ionicons name="images-outline" size={24} color={colors.text} />
          </Pressable>
        )}
      </View>

      <GifPicker visible={gifPickerOpen} onSelect={selectGif} onClose={() => setGifPickerOpen(false)} />
    </>
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
  commentsStatus: { paddingVertical: 16, alignItems: 'center' },
  commentsError: { fontSize: 13 },
});
