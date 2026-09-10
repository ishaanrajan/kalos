/**
 * One comment: avatar, bold username inline with the body, then a small
 * timestamp underneath.
 */

import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { spacing, useTheme } from '../lib/theme';
import type { Comment, Timestamp } from '../lib/types';
import { Avatar } from './Avatar';
import { MentionText } from './MentionText';

export interface CommentRowProps {
  /** The comment, straight off the wire. `comment.author` supplies the username. */
  comment: Comment;
  /** Fully-resolved avatar URL for the comment's author. */
  avatarUrl?: string | null;
  /** Overrides `comment.author?.username` — useful when the join is absent. */
  username?: string;
  /** Renders a small heart on the right when defined. */
  liked?: boolean;
  /**
   * The three handlers below are handed the comment they fired on. A comment
   * list can then pass one callback identity to every row instead of a fresh
   * `() => doThing(item)` per row, which is what the React.memo() at the
   * bottom needs to actually skip anything: FlatList hands VirtualizedList a
   * new `renderItem` on every render (its non-strictMode `_renderer`), so
   * each row's props are rebuilt whenever the screen re-renders at all.
   * Callers that don't need the argument can still pass a `() => void`.
   */
  onPressAuthor?: (comment: Comment) => void;
  onPressLike?: (comment: Comment) => void;
  onLongPress?: (comment: Comment) => void;
  /** Tapping an @mention in the comment body. */
  onPressMention?: (username: string) => void;
  /** Avatar diameter. Defaults to 32. */
  avatarSize?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Compact age used inside comment lists: "now", "42m", "3h", "2d", "6w". */
export function formatCommentAge(iso: Timestamp, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return '';
  }
  const elapsed = Math.max(0, now - then);

  if (elapsed < MINUTE) {
    return 'now';
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h`;
  }
  if (elapsed < WEEK) {
    return `${Math.floor(elapsed / DAY)}d`;
  }
  return `${Math.floor(elapsed / WEEK)}w`;
}

function CommentRowImpl({
  comment,
  avatarUrl,
  username: usernameOverride,
  liked,
  onPressAuthor,
  onPressLike,
  onLongPress,
  onPressMention,
  avatarSize = 32,
  style,
  testID,
}: CommentRowProps) {
  const { colors, typography } = useTheme();
  const username = usernameOverride ?? comment.author?.username ?? 'someone';
  const body = comment.body;
  const age = useMemo(() => formatCommentAge(comment.created_at), [comment.created_at]);

  // Bound to this row's comment here rather than at the call site, for the
  // same two reasons as PostCard's useBoundToPost: RN press handlers pass a
  // synthetic event (a caller's `(comment) => ...` would receive a
  // GestureResponderEvent), and `undefined` has to survive -- the row's
  // Pressable and the heart both branch on whether a handler exists at all.
  const handlePressAuthor = useMemo(
    () => (onPressAuthor ? () => onPressAuthor(comment) : undefined),
    [onPressAuthor, comment],
  );
  const handlePressLike = useMemo(
    () => (onPressLike ? () => onPressLike(comment) : undefined),
    [onPressLike, comment],
  );
  const handleLongPress = useMemo(
    () => (onLongPress ? () => onLongPress(comment) : undefined),
    [onLongPress, comment],
  );

  return (
    <Pressable
      onLongPress={handleLongPress}
      disabled={!handleLongPress}
      testID={testID}
      accessibilityLabel={`${username}: ${body}`}
      style={[styles.root, style]}
    >
      <Avatar
        url={avatarUrl}
        username={username}
        size={avatarSize}
        onPress={handlePressAuthor}
        style={styles.avatar}
      />

      <View style={styles.content}>
        <Text style={[typography.body, { color: colors.text }]}>
          <Text
            style={[typography.bodyStrong, { color: colors.text }]}
            onPress={handlePressAuthor}
            suppressHighlighting
          >
            {username}
          </Text>
          {'  '}
          <MentionText text={body} mentionColor={colors.mention} onPressMention={onPressMention} />
        </Text>

        {age ? (
          <Text style={[typography.timestamp, styles.age, { color: colors.textSecondary }]}>
            {age}
          </Text>
        ) : null}
      </View>

      {handlePressLike ? (
        <Pressable
          onPress={handlePressLike}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={liked ? 'Unlike comment' : 'Like comment'}
          accessibilityState={{ selected: liked === true }}
          style={styles.like}
        >
          <Ionicons
            name={liked ? 'heart' : 'heart-outline'}
            size={13}
            color={liked ? colors.heart : colors.textSecondary}
          />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

/**
 * Memoized because the post screen re-renders on far more than new comments.
 *
 * Every render of app/post/[id].tsx used to rebuild every mounted row -- and
 * with the draft text living in that screen's state, that was once per
 * keystroke on a thread of any length. The draft now lives in the composer,
 * but the screen still re-renders whenever the post or the mutation state
 * changes, and each of those re-renders would otherwise re-run MentionText's
 * parse and the age formatting for every row on screen.
 */
export const CommentRow = React.memo(CommentRowImpl);

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  avatar: {
    marginTop: 1,
  },
  content: {
    flex: 1,
    marginLeft: spacing.md,
  },
  age: {
    marginTop: spacing.xs + 1,
  },
  like: {
    paddingLeft: spacing.sm,
    paddingTop: spacing.xs,
  },
});

export default CommentRow;
