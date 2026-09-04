/**
 * Shared type contract for Kalos.
 *
 * These types mirror the Postgres schema in supabase/migrations and are the
 * agreed interface between the database layer, the filter engine, and the UI.
 * Change them here first, then propagate.
 */

export type UUID = string;

/** ISO-8601 timestamp string, as returned by PostgREST. */
export type Timestamp = string;

export interface Profile {
  id: UUID;
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_path: string | null;
  post_count: number;
  follower_count: number;
  following_count: number;
  created_at: Timestamp;
  /** Last time the Activity tab was opened — drives its unread red dot. */
  activity_read_at: Timestamp | null;
  /**
   * False only for an account created after this feature shipped that hasn't
   * yet added a profile photo and posted once — existing accounts are never
   * retroactively forced through onboarding, hence the default of true.
   */
  onboarded: boolean;
}

export interface Post {
  id: UUID;
  author_id: UUID;
  image_path: string;
  width: number;
  height: number;
  caption: string | null;
  /** Name of the filter applied at capture time, e.g. "Valencia". */
  filter_name: string | null;
  like_count: number;
  comment_count: number;
  created_at: Timestamp;
}

export interface Comment {
  id: UUID;
  post_id: UUID;
  author_id: UUID;
  body: string;
  created_at: Timestamp;
  author?: Pick<Profile, 'id' | 'username' | 'avatar_path'>;
}

/**
 * A post as returned by the home_feed / explore_feed RPCs: the post columns
 * flattened together with its author and the viewer's own like state.
 */
export interface FeedPost extends Post {
  author_username: string;
  author_display_name: string | null;
  author_avatar_path: string | null;
  /** Whether the current viewer has liked this post. */
  viewer_has_liked: boolean;
  /** Only populated by explore_feed — why this post is being shown. */
  reason?: ExploreReason;
  /** Username of the follow that connects the viewer to this post. */
  reason_username?: string;
}

/**
 * Explore only ever surfaces posts reachable through the social graph.
 * These are the only two ways in — there is deliberately no "trending" or
 * "recommended" reason, because no post enters Explore on engagement.
 */
export type ExploreReason = 'liked_by' | 'followed_by';

/** Keyset pagination cursor. Ordering is always (created_at DESC, id DESC). */
export interface FeedCursor {
  before: Timestamp;
  before_id: UUID;
}

export const PAGE_SIZE = 12;

/** Activity tab entries, newest first. Never algorithmically reordered. */
export type ActivityEvent =
  | { kind: 'like'; actor: Profile; post_id: UUID; image_path: string; created_at: Timestamp }
  | { kind: 'comment'; actor: Profile; post_id: UUID; image_path: string; body: string; created_at: Timestamp }
  | { kind: 'follow'; actor: Profile; created_at: Timestamp };

/**
 * A single DM. Every thread is with "ishaan" — thread_user_id is always the
 * non-ishaan participant, so it IS the thread's identity.
 */
export interface DMMessage {
  id: UUID;
  thread_user_id: UUID;
  thread_with_id: UUID;
  sender_id: UUID;
  body: string;
  created_at: Timestamp;
  /** Set by the recipient when they open the thread — drives read receipts. */
  read_at: Timestamp | null;
  /**
   * Every thread is still keyed to one human, but more than one account can
   * now post into it (ishaan, or a bot like the Drake account) -- this is
   * what lets the client attribute each message to who actually sent it
   * instead of assuming it's always the thread's nominal other party.
   */
  sender?: Pick<Profile, 'username' | 'avatar_path'>;
}

/** One row of ishaan's inbox: a thread plus its most recent message. */
export interface DMThreadSummary {
  thread_user_id: UUID;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  last_body: string;
  last_sender_id: UUID;
  last_created_at: Timestamp;
}

// ---------------------------------------------------------------------------
// Filter engine contract
// ---------------------------------------------------------------------------

/**
 * Skia blend modes used by filter overlays. Kept as a string union rather than
 * importing from @shopify/react-native-skia so that pure-logic modules (and
 * tests) can use this contract without pulling in native code.
 */
export type OverlayBlend = 'overlay' | 'softLight' | 'multiply' | 'screen' | 'color' | 'luminosity';

export interface FilterOverlay {
  kind: 'solid' | 'radial';
  /** For 'solid', a single colour. For 'radial', inner → outer stops. */
  colors: string[];
  blend: OverlayBlend;
  /** 0–1, scaled by the strength slider. */
  opacity: number;
}

export interface Filter {
  /** Display name, e.g. "X-Pro II". */
  name: string;
  /**
   * 4x5 row-major colour matrix (20 numbers), the same layout Skia's
   * ColorMatrix takes. Offsets in column 5 are in 0–1 space.
   */
  matrix: number[];
  overlay?: FilterOverlay;
}

/** Image dimensions used when baking and when laying out a post. */
export interface ImageSize {
  width: number;
  height: number;
}
