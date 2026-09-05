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
}

export function MentionText({ text, mentionColor, onPressMention }: MentionTextProps) {
  const segments = parseMentions(text);
  return (
    <>
      {segments.map((segment, i) =>
        segment.type === 'mention' ? (
          <Text
            key={i}
            style={{ color: mentionColor, fontWeight: '600' }}
            onPress={onPressMention ? () => onPressMention(segment.username!) : undefined}
            suppressHighlighting
          >
            {segment.value}
          </Text>
        ) : (
          <Text key={i}>{segment.value}</Text>
        ),
      )}
    </>
  );
}

export default MentionText;
