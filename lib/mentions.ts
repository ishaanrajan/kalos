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
  type: 'text' | 'mention' | 'hashtag';
  /** The literal text to render, "@" or "#" included. */
  value: string;
  /** Only set for `mention` segments -- the username, lowercased, no "@". */
  username?: string;
  /** Only set for `hashtag` segments -- the tag, lowercased, no "#". */
  hashtag?: string;
}

const MENTION_RE = /@([a-z0-9._]{3,30})/gi;

/**
 * Mentions and hashtags in one pass, so segments come out in the order they
 * appear rather than needing two passes reconciled afterwards.
 *
 * The two halves deliberately have different rules:
 *
 * - The mention branch is character-for-character the old MENTION_RE, so
 *   this change can't quietly alter which @handles linkify (or which ones
 *   notify's matching copy agrees with).
 * - Hashtags require a boundary before the "#" and exclude dots from the
 *   tag charset. Dots are legal in usernames but end a hashtag -- "#nyc.jpg"
 *   is the tag "nyc" followed by ".jpg", which is what Instagram does and
 *   what anyone writing a filename in a caption expects.
 *
 * That boundary is matched as a captured character rather than a lookbehind
 * on purpose: lookbehind support in Hermes isn't something to bet caption
 * rendering on. The captured character is ordinary text and gets handed back
 * to the preceding text segment below.
 */
const TOKEN_RE = /@([a-z0-9._]{3,30})|(^|[^\w#])#([a-z0-9_]{1,60})/gi;

export function parseMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(TOKEN_RE)) {
    const matchStart = match.index ?? 0;
    const isMention = match[1] !== undefined;
    // For a hashtag the pattern also consumed the character before the "#".
    // That character isn't part of the tag, so the token really starts after
    // it and it belongs to the text run in front.
    const lead = isMention ? '' : (match[2] ?? '');
    const tokenStart = matchStart + lead.length;

    if (tokenStart > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, tokenStart) });
    }

    if (isMention) {
      segments.push({ type: 'mention', value: match[0], username: match[1]!.toLowerCase() });
      lastIndex = tokenStart + match[0].length;
    } else {
      const tag = match[3]!;
      segments.push({ type: 'hashtag', value: `#${tag}`, hashtag: tag.toLowerCase() });
      lastIndex = tokenStart + tag.length + 1;
    }
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return segments;
}

/** Every distinct #hashtag in `text`, lowercased, deduplicated. */
export function extractHashtags(text: string): string[] {
  const tags = new Set<string>();
  for (const segment of parseMentions(text)) {
    if (segment.type === 'hashtag') tags.add(segment.hashtag!);
  }
  return [...tags];
}

/** Every distinct username @mentioned in `text`, lowercased, deduplicated. */
export function extractMentionedUsernames(text: string): string[] {
  const usernames = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    usernames.add(match[1]!.toLowerCase());
  }
  return [...usernames];
}

// ---------------------------------------------------------------------------
// Autocomplete -- driven off the trailing "word" being typed, not real
// cursor tracking. Composing forward (the overwhelming case on mobile) this
// is indistinguishable from proper cursor-position detection and is far
// simpler; it just doesn't offer suggestions if you go back and edit an
// "@partial" that isn't at the end of the text.
// ---------------------------------------------------------------------------

const TRAILING_MENTION_RE = /(^|\s)@([a-z0-9._]*)$/i;

/**
 * The in-progress username being typed after a trailing "@", or `null` if
 * the text doesn't currently end in one. Empty string means just "@" with
 * nothing typed yet -- callers should still show suggestions for that (an
 * unfiltered list), not treat it as "no query".
 */
export function activeMentionQuery(text: string): string | null {
  const match = text.match(TRAILING_MENTION_RE);
  return match ? match[2]!.toLowerCase() : null;
}

/** Replaces the trailing "@partial" with "@username " (trailing space so
 * typing can continue immediately), preserving whatever preceded the "@". */
export function applyMentionSelection(text: string, username: string): string {
  return text.replace(TRAILING_MENTION_RE, (_match, lead: string) => `${lead}@${username} `);
}
