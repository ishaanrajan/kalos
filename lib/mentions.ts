/**
 * @mentions -- shared parsing so comment bodies and captions link the same
 * way. Matches the same username charset sign-up enforces (lowercase
 * letters, digits, dots, underscores, 3-30 chars), case-insensitively, since
 * someone might type "@Maya" even though the stored username is "maya".
 *
 * Linkifies syntactically regardless of whether the username actually
 * exists -- same as real Instagram, and cheaper than a lookup on every
 * render. A mention of a nonexistent account just 404s on tap, same as
 * typing a bad username into the URL bar would.
 */

export interface MentionSegment {
  type: 'text' | 'mention';
  /** The literal text to render, "@" included for a mention. */
  value: string;
  /** Only set for `mention` segments -- the username, lowercased, no "@". */
  username?: string;
}

const MENTION_RE = /@([a-z0-9._]{3,30})/gi;

export function parseMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, start) });
    }
    segments.push({ type: 'mention', value: match[0], username: match[1]!.toLowerCase() });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return segments;
}

/** Every distinct username @mentioned in `text`, lowercased, deduplicated. */
export function extractMentionedUsernames(text: string): string[] {
  const usernames = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    usernames.add(match[1]!.toLowerCase());
  }
  return [...usernames];
}
