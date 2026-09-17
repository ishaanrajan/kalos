/**
 * The music catalog.
 *
 * This is the only file in the app that knows where tracks come from. Swapping
 * to a licensed library later is a rewrite of this file and nothing else --
 * everything downstream speaks Track and PostMusic.
 *
 * Source is Apple's real Music Catalog API (MusicKit), not the legacy free
 * `itunes.apple.com/search` endpoint this used to hit. The legacy endpoint
 * turned out to default to (and for a lot of popular hits, only index) the
 * *clean* edition of a song -- verified directly: searching it for "HUMBLE."
 * or "WAP" returned nothing but `trackExplicitness: "cleaned"` results,
 * regardless of any query parameter. The real catalog carries both editions
 * as separate resources with a genuine `contentRating` field, and
 * preferExplicit() below picks the explicit one when both exist.
 *
 * Catalog search and 30-second previews need only a *developer token* -- a
 * JWT signed with the MusicKit private key -- not a Music-User-Token or an
 * Apple Music subscription from anyone. That's what makes this still work
 * the same way the iTunes version did: no per-user auth, called straight
 * from the device. See scripts/mint-apple-music-token.ts for how the token
 * itself is produced (by hand, every few months -- Apple caps it at 6
 * months) and EXPO_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN below for where it
 * lives. Unlike the GIPHY key, this one is scoped to one Apple Developer
 * account's catalog-read quota rather than being free of any owner, so if
 * Apple's rate limit ever turns out to be per-token rather than per-caller,
 * it's a shared budget across every device running the app -- unconfirmed,
 * and not a concern at this app's size, but worth knowing if search ever
 * starts failing for everyone at once.
 *
 * Apple still licenses previews to promote the Store, so they're streamed
 * rather than cached to disk, and a post carrying one has to offer a way
 * through to the track's Store page. That is what store_url is for, and why
 * PostCard's music pill is tappable.
 */

import type { PostMusic } from './types';

// Note: this module deliberately imports nothing from react-native or expo-*.
// scripts/verify-music.ts runs it under plain Node to check the catalog still
// serves playable previews, and a single native import makes that impossible.
// Opening a track's Store page is the screens' job for the same reason.

/** A search result from the catalog, before it's attached to a post. */
export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  /** 30s m4a. Always present -- results without one are dropped at parse time. */
  previewUrl: string;
  storeUrl: string;
}

const SEARCH_ENDPOINT = 'https://api.music.apple.com/v1/catalog/us/search';
const SEARCH_LIMIT = 25;

interface AppleMusicPreview {
  url?: string;
}

interface AppleMusicSongAttributes {
  name?: string;
  artistName?: string;
  albumName?: string;
  artwork?: { url?: string };
  /** No value means no rating -- treated the same as "clean" when ranking. */
  contentRating?: 'clean' | 'explicit';
  durationInMillis?: number;
  previews?: AppleMusicPreview[];
  /** The track's own Apple Music page -- this API's equivalent of trackViewUrl. */
  url?: string;
}

/** The shape we actually read off a result; the real payload is much wider. */
interface AppleMusicSong {
  id?: string;
  attributes?: AppleMusicSongAttributes;
}

function developerToken(): string {
  const token = process.env.EXPO_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN;
  if (!token) {
    throw new Error(
      'EXPO_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN is not set -- run scripts/mint-apple-music-token.ts and add its output to .env',
    );
  }
  return token;
}

/**
 * Artwork URLs come back as a `{w}x{h}` template, not a fixed size baked into
 * the path -- the caller fills in whatever it's actually going to draw.
 */
function upscaleArtwork(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  return url.replace('{w}', '300').replace('{h}', '300');
}

/** A parsed result, still carrying what preferExplicit() needs to dedupe it. */
interface Candidate extends Track {
  contentRating?: 'clean' | 'explicit';
  /** Same song, different edition: same title, artist, and length. */
  dedupeKey: string;
}

function toCandidate(raw: AppleMusicSong): Candidate | null {
  const a = raw.attributes;
  const previewUrl = a?.previews?.[0]?.url;
  // Some catalog entries -- a few classical recordings, some regional
  // licensing -- carry no preview at all. A track we can't play is not a
  // track we can offer, so it never reaches the picker.
  if (!raw.id || !previewUrl || !a?.name || !a?.artistName) {
    return null;
  }
  return {
    id: raw.id,
    title: a.name,
    artist: a.artistName,
    album: a.albumName ?? null,
    artworkUrl: upscaleArtwork(a.artwork?.url),
    previewUrl,
    storeUrl: a.url ?? '',
    contentRating: a.contentRating,
    dedupeKey: `${a.artistName.toLowerCase()}|${a.name.toLowerCase()}|${a.durationInMillis ?? ''}`,
  };
}

const RATING_RANK: Record<string, number> = { explicit: 0, clean: 1 };

/**
 * A clean edit and an explicit one are two distinct catalog entries with
 * matching title/artist/length -- a friend-group app has no reason to
 * default to the radio edit, so keep whichever edition ranks best per song
 * and drop the rest, preserving the catalog's own relevance order otherwise.
 */
function preferExplicit(candidates: Candidate[]): Track[] {
  const bestForKey = new Map<string, Candidate>();
  for (const c of candidates) {
    const existing = bestForKey.get(c.dedupeKey);
    const rank = RATING_RANK[c.contentRating ?? ''] ?? 2;
    const existingRank = existing ? (RATING_RANK[existing.contentRating ?? ''] ?? 2) : Infinity;
    if (rank < existingRank) {
      bestForKey.set(c.dedupeKey, c);
    }
  }
  const seen = new Set<string>();
  const tracks: Track[] = [];
  for (const c of candidates) {
    if (seen.has(c.dedupeKey)) continue;
    seen.add(c.dedupeKey);
    const { contentRating: _rating, dedupeKey: _key, ...track } = bestForKey.get(c.dedupeKey)!;
    tracks.push(track);
  }
  return tracks;
}

/**
 * Search the catalog. `signal` is threaded through so a superseded keystroke's
 * request is actually cancelled rather than left to land out of order.
 */
export async function searchTracks(query: string, signal?: AbortSignal): Promise<Track[]> {
  const term = query.trim();
  if (!term) {
    return [];
  }

  const url = `${SEARCH_ENDPOINT}?term=${encodeURIComponent(term)}&types=songs&limit=${SEARCH_LIMIT}`;

  const response = await fetch(url, {
    signal,
    headers: { Authorization: `Bearer ${developerToken()}` },
  });
  if (!response.ok) {
    throw new Error(`Music search failed (${response.status})`);
  }

  const body = (await response.json()) as { results?: { songs?: { data?: AppleMusicSong[] } } };
  const candidates = (body.results?.songs?.data ?? [])
    .map(toCandidate)
    .filter((c): c is Candidate => c !== null);
  return preferExplicit(candidates);
}

/** Freeze a chosen track and clip offset into the shape a post row stores. */
export function trackToPostMusic(track: Track, startMs: number): PostMusic {
  return {
    track_id: track.id,
    title: track.title,
    artist: track.artist,
    artwork_url: track.artworkUrl,
    preview_url: track.previewUrl,
    store_url: track.storeUrl,
    start_ms: Math.max(0, Math.round(startMs)),
  };
}
