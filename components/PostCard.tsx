/**
 * The feed post card.
 *
 * Header (avatar, username) -> square-first photo -> action row ->
 * like count -> caption -> comment preview -> uppercase relative timestamp.
 *
 * Double-tapping the photo likes it and plays the white heart burst. A single
 * tap falls through to `onPressImage`, so the two gestures are composed with
 * `Gesture.Exclusive(doubleTap, singleTap)` — the double tap gets first refusal
 * and the single tap only fires once the double-tap window has lapsed.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type {
  NativeSyntheticEvent,
  StyleProp,
  TextLayoutEventData,
  ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import Feather from '@expo/vector-icons/Feather';
import Ionicons from '@expo/vector-icons/Ionicons';

import { hairlineWidth, spacing, useTheme } from '../lib/theme';
import type { FeedPost, Timestamp, UUID } from '../lib/types';
import { Avatar } from './Avatar';
import { LikeButton } from './LikeButton';

/** A comment rendered inline under the caption. */
export interface PostCardComment {
  id: UUID;
  username: string;
  body: string;
}

export interface PostCardProps {
  /**
   * The post, straight off the `home_feed` / `explore_feed` RPC. Supplies the
   * author, counts, caption, viewer like state, and — on Explore —
   * the `reason` / `reason_username` behind the chip.
   */
  post: FeedPost;
  /** Fully-resolved public URL for the (already filtered) photo. */
  imageUrl: string;
  /** Fully-resolved public URL for the author's avatar. */
  avatarUrl?: string | null;

  /**
   * Toggles the like. The heart button always calls it; a double-tap only calls
   * it when the post is not already liked, so double-tapping never un-likes.
   */
  onLike: () => void;
  onPressAuthor?: () => void;
  onPressComments?: () => void;
  onPressLikes?: () => void;
  onPressImage?: () => void;
  onPressOptions?: () => void;
  /** Tapping the Explore reason chip. */
  onPressReason?: () => void;

  /** Shows the "View all N comments" line. Defaults to true. */
  showCommentPreview?: boolean;
  /** Comments rendered inline between the caption and the timestamp. */
  previewComments?: PostCardComment[];
  /** Caption lines before the "more" affordance. Defaults to 2. */
  captionNumberOfLines?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

// --- aspect ratio -----------------------------------------------------------

/**
 * 2015 Instagram was square; portrait and landscape arrived clamped to 4:5 and
 * 1.91:1. Anything outside that gets cropped back into range, and anything
 * near-square snaps to exactly square.
 */
const MIN_RATIO = 4 / 5;
const MAX_RATIO = 1.91;

export function displayAspectRatio(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 1;
  }
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.04) {
    return 1;
  }
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

// --- timestamp --------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

/**
 * The 2015 post timestamp: "JUST NOW", "3 HOURS AGO", "2 DAYS AGO", then an
 * absolute date past a week. Returned in natural case — the `timestamp` type
 * token applies `textTransform: 'uppercase'`.
 */
export function formatPostTimestamp(iso: Timestamp, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return '';
  }
  const elapsed = Math.max(0, now - then);

  if (elapsed < MINUTE) {
    return 'Just now';
  }
  if (elapsed < HOUR) {
    return plural(Math.floor(elapsed / MINUTE), 'minute');
  }
  if (elapsed < DAY) {
    return plural(Math.floor(elapsed / HOUR), 'hour');
  }
  if (elapsed < WEEK) {
    return plural(Math.floor(elapsed / DAY), 'day');
  }

  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    ...(sameYear ? null : { year: 'numeric' }),
  });
}

function formatCount(count: number, singular: string, pluralWord: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralWord}`;
}

// --- burst animation --------------------------------------------------------

const BURST_SIZE = 96;
const BURST_SPRING = { damping: 11, stiffness: 240, mass: 0.6 };

export function PostCard({
  post,
  imageUrl,
  avatarUrl,
  onLike,
  onPressAuthor,
  onPressComments,
  onPressLikes,
  onPressImage,
  onPressOptions,
  onPressReason,
  showCommentPreview = true,
  previewComments,
  captionNumberOfLines = 2,
  style,
  testID,
}: PostCardProps) {
  const { colors, typography } = useTheme();

  const {
    id: postId,
    caption,
    like_count: likeCount,
    comment_count: commentCount,
    created_at: createdAt,
    author_username: authorUsername,
    viewer_has_liked: liked,
    reason,
    reason_username: reasonUsername,
  } = post;

  const aspectRatio = useMemo(
    () => displayAspectRatio(post.width, post.height),
    [post.width, post.height],
  );
  const timestamp = useMemo(() => formatPostTimestamp(createdAt), [createdAt]);

  const [captionExpanded, setCaptionExpanded] = useState(false);
  const [captionOverflows, setCaptionOverflows] = useState(false);

  const burstScale = useSharedValue(0);
  const burstOpacity = useSharedValue(0);

  // `liked` is read inside a gesture callback; a ref keeps the gesture object
  // from being rebuilt on every like.
  const likedRef = useRef(liked);
  likedRef.current = liked;

  const playBurst = useCallback(() => {
    burstScale.value = withSequence(
      withTiming(0, { duration: 0 }),
      withSpring(1, BURST_SPRING),
      withDelay(280, withTiming(1.25, { duration: 200 })),
    );
    burstOpacity.value = withSequence(
      withTiming(1, { duration: 0 }),
      withDelay(460, withTiming(0, { duration: 200 })),
    );
  }, [burstScale, burstOpacity]);

  const handleDoubleTap = useCallback(() => {
    playBurst();
    if (!likedRef.current) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      onLike();
    }
  }, [playBurst, onLike]);

  // `.runOnJS(true)` keeps the callbacks on the JS thread so they can call the
  // props directly. Assigning a shared value from JS still runs the animation
  // itself on the UI thread.
  const photoGesture = useMemo(() => {
    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .maxDuration(260)
      .runOnJS(true)
      .onEnd((_event, success) => {
        if (success) {
          handleDoubleTap();
        }
      });

    const singleTap = Gesture.Tap()
      .numberOfTaps(1)
      .runOnJS(true)
      .onEnd((_event, success) => {
        if (success && onPressImage) {
          onPressImage();
        }
      });

    return Gesture.Exclusive(doubleTap, singleTap);
  }, [handleDoubleTap, onPressImage]);

  const burstStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      opacity: burstOpacity.value,
      transform: [{ scale: burstScale.value }],
    };
  });

  const onCaptionMeasure = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      setCaptionOverflows(event.nativeEvent.lines.length > captionNumberOfLines);
    },
    [captionNumberOfLines],
  );

  const reasonLabel = useMemo(() => {
    if (!reason || !reasonUsername) {
      return null;
    }
    return reason === 'liked_by' ? `Liked by ${reasonUsername}` : `Followed by ${reasonUsername}`;
  }, [reason, reasonUsername]);

  return (
    <View
      style={[styles.root, { backgroundColor: colors.surface }, style]}
      testID={testID}
    >
      {/* Explore reason chip */}
      {reasonLabel ? (
        <Pressable
          onPress={onPressReason}
          disabled={!onPressReason}
          style={[styles.reasonRow, { borderBottomWidth: hairlineWidth, borderBottomColor: colors.border }]}
          accessibilityRole="text"
          accessibilityLabel={reasonLabel}
        >
          <Ionicons
            name={reason === 'liked_by' ? 'heart-outline' : 'person-add-outline'}
            size={12}
            color={colors.textSecondary}
          />
          <Text style={[typography.timestamp, styles.reasonText, { color: colors.textSecondary }]}>
            {reasonLabel}
          </Text>
        </Pressable>
      ) : null}

      {/* Header */}
      <View style={styles.header}>
        <Avatar
          url={avatarUrl}
          username={authorUsername}
          size={32}
          ring
          onPress={onPressAuthor}
        />

        {/* The line under the username is where a location would go, if this
            ever grows one. It is deliberately not the filter name. */}
        <View style={styles.headerText}>
          <Text
            style={[typography.username, { color: colors.text }]}
            numberOfLines={1}
            onPress={onPressAuthor}
            suppressHighlighting
          >
            {authorUsername}
          </Text>
        </View>

        {onPressOptions ? (
          <Pressable
            onPress={onPressOptions}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Post options"
          >
            <Feather name="more-horizontal" size={20} color={colors.text} />
          </Pressable>
        ) : null}
      </View>

      {/* Photo */}
      <GestureDetector gesture={photoGesture}>
        <View
          style={[styles.photo, { aspectRatio, backgroundColor: colors.imagePlaceholder }]}
          accessible
          accessibilityRole="image"
          accessibilityLabel={caption ?? `Photo by ${authorUsername}`}
        >
          <Image
            source={imageUrl}
            style={styles.photoImage}
            contentFit="cover"
            transition={180}
            cachePolicy="memory-disk"
            recyclingKey={postId}
            accessible={false}
          />

          <Animated.View style={[styles.burst, burstStyle]} pointerEvents="none">
            <Ionicons name="heart" size={BURST_SIZE} color="#ffffff" style={styles.burstIcon} />
          </Animated.View>
        </View>
      </GestureDetector>

      {/* Actions */}
      <View style={styles.actions}>
        <LikeButton liked={liked} onPress={onLike} size={26} style={styles.action} />

        <Pressable
          onPress={onPressComments}
          disabled={!onPressComments}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Comment"
          style={styles.action}
        >
          <Feather name="message-circle" size={24} color={colors.text} />
        </Pressable>
      </View>

      {/* Meta */}
      <View style={styles.meta}>
        {likeCount > 0 ? (
          <Text
            style={[typography.bodyStrong, { color: colors.text }]}
            onPress={onPressLikes}
            suppressHighlighting
          >
            {formatCount(likeCount, 'like', 'likes')}
          </Text>
        ) : null}

        {caption ? (
          <View style={styles.captionBlock}>
            <Text
              style={[typography.body, { color: colors.text }]}
              numberOfLines={captionExpanded ? undefined : captionNumberOfLines}
            >
              <Text
                style={[typography.bodyStrong, { color: colors.text }]}
                onPress={onPressAuthor}
                suppressHighlighting
              >
                {authorUsername}
              </Text>
              {'  '}
              {caption}
            </Text>

            {/* Off-screen copy, measured to decide whether "more" is warranted. */}
            {!captionExpanded ? (
              <Text
                style={[typography.body, styles.measure, { color: colors.text }]}
                onTextLayout={onCaptionMeasure}
                accessible={false}
                pointerEvents="none"
              >
                {`${authorUsername}  ${caption}`}
              </Text>
            ) : null}

            {captionOverflows && !captionExpanded ? (
              <Text
                style={[typography.meta, styles.more, { color: colors.textSecondary }]}
                onPress={() => setCaptionExpanded(true)}
                suppressHighlighting
              >
                more
              </Text>
            ) : null}
          </View>
        ) : null}

        {showCommentPreview && commentCount > 0 ? (
          <Text
            style={[typography.meta, styles.viewComments, { color: colors.textSecondary }]}
            onPress={onPressComments}
            suppressHighlighting
          >
            {commentCount === 1
              ? 'View 1 comment'
              : `View all ${commentCount.toLocaleString()} comments`}
          </Text>
        ) : null}

        {previewComments?.map((comment) => (
          <Text
            key={comment.id}
            style={[typography.body, styles.previewComment, { color: colors.text }]}
            numberOfLines={2}
          >
            <Text style={[typography.bodyStrong, { color: colors.text }]}>
              {comment.username}
            </Text>
            {'  '}
            {comment.body}
          </Text>
        ))}

        {timestamp ? (
          <Text style={[typography.timestamp, styles.timestamp, { color: colors.textSecondary }]}>
            {timestamp}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  reasonText: {
    marginLeft: spacing.xs + 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  headerText: {
    flex: 1,
    marginLeft: spacing.md - 2,
  },
  photo: {
    width: '100%',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoImage: {
    width: '100%',
    height: '100%',
  },
  burst: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  burstIcon: {
    // Keeps the white heart legible over a bright photo.
    textShadowColor: 'rgba(0, 0, 0, 0.28)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 8,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md - 2,
    paddingBottom: spacing.sm,
  },
  action: {
    marginRight: spacing.lg,
  },
  meta: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  captionBlock: {
    marginTop: spacing.xs + 2,
  },
  measure: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    opacity: 0,
    zIndex: -1,
  },
  more: {
    marginTop: 2,
  },
  viewComments: {
    marginTop: spacing.xs + 2,
  },
  previewComment: {
    marginTop: spacing.xs,
  },
  timestamp: {
    marginTop: spacing.sm,
  },
});

export default PostCard;
