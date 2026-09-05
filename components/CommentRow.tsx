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
  onPressAuthor?: () => void;
  onPressLike?: () => void;
  onLongPress?: () => void;
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

export function CommentRow({
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

  return (
    <Pressable
      onLongPress={onLongPress}
      disabled={!onLongPress}
      testID={testID}
      accessibilityLabel={`${username}: ${body}`}
      style={[styles.root, style]}
    >
      <Avatar
        url={avatarUrl}
        username={username}
        size={avatarSize}
        onPress={onPressAuthor}
        style={styles.avatar}
      />

      <View style={styles.content}>
        <Text style={[typography.body, { color: colors.text }]}>
          <Text
            style={[typography.bodyStrong, { color: colors.text }]}
            onPress={onPressAuthor}
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

      {onPressLike ? (
        <Pressable
          onPress={onPressLike}
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
