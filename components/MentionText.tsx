/**
 * Renders text with @mentions styled and tappable, as a React fragment --
 * not its own <Text> -- so it composes inline inside a parent <Text> that
 * already carries a bold username prefix (CommentRow, PostCard's caption
 * and preview-comment rows all follow that "bold name + body" shape).
 */

import React from 'react';
import { Text } from 'react-native';
import { parseMentions } from '../lib/mentions';

export interface MentionTextProps {
  text: string;
  mentionColor: string;
  onPressMention?: (username: string) => void;
  /**
   * Hashtags are styled like mentions but are only tappable if this is given.
   * There is no hashtag route in the app yet -- search_profiles searches
   * accounts, not captions -- so leaving it off renders them as coloured but
   * inert text rather than as a link that 404s.
   */
  onPressHashtag?: (hashtag: string) => void;
}

export function MentionText({
  text,
  mentionColor,
  onPressMention,
  onPressHashtag,
}: MentionTextProps) {
  const segments = parseMentions(text);
  return (
    <>
      {segments.map((segment, i) => {
        if (segment.type === 'text') {
          return <Text key={i}>{segment.value}</Text>;
        }
        // Mentions and hashtags share one style: same blue, same weight. They
        // read as the same class of thing in a caption, and Instagram has
        // always drawn them identically.
        const onPress =
          segment.type === 'mention'
            ? onPressMention && (() => onPressMention(segment.username!))
            : onPressHashtag && (() => onPressHashtag(segment.hashtag!));
        return (
          <Text
            key={i}
            style={{ color: mentionColor, fontWeight: '600' }}
            onPress={onPress || undefined}
            suppressHighlighting
          >
            {segment.value}
          </Text>
        );
      })}
    </>
  );
}

export default MentionText;
