/**
 * The music catalog.
 *
 * This is the only file in the app that knows where tracks come from. Swapping
 * to a licensed library later is a rewrite of this file and nothing else --
 * everything downstream speaks Track and PostMusic.
 *
 * Today that source is Apple's iTunes Search API: free, unauthenticated, and
 * covering essentially every commercial release, returning a 30-second m4a
 * preview plus artwork per track.
 *
 * Two constraints it imposes, both load-bearing elsewhere:
 *
 *  - It is rate limited to roughly 20 requests per minute PER IP. That is why
 *    this runs on the device instead of behind an Edge Function like the rest
 *    of the app's server work: proxying would put every user on one shared
 *    budget and throttle immediately. There is no secret to protect here, so
 *    the "secrets live server-side" rule isn't in play -- the API takes no key.
 *    It is still why searches are debounced (see useDebouncedValue).
 *
 *  - Apple licenses previews to promote the Store, so they must be streamed
 *    rather than cached to disk, and a post carrying one has to offer a way
 *    through to the track's Store page. That is what store_url is for, and why
 *    PostCard's music pill is tappable.
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

const SEARCH_ENDPOINT = 'https://itunes.apple.com/search';
const SEARCH_LIMIT = 25;

/** The shape we actually read off a result; the real payload is much wider. */
interface ITunesResult {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
  previewUrl?: string;
  trackViewUrl?: string;
}

/**
 * Apple serves any square size off the artwork path, and the default 100px is
 * visibly soft at the sizes we draw it. Swapping the dimensions in the URL is
 * the documented way up.
 */
function upscaleArtwork(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  return url.replace(/\/(\d+)x(\d+)bb\.(jpg|png)$/, '/300x300bb.$3');
}

function toTrack(raw: ITunesResult): Track | null {
  // Some catalog entries -- a few classical recordings, some regional
  // licensing -- carry no preview at all. A track we can't play is not a
  // track we can offer, so it never reaches the picker.
  if (!raw.previewUrl || !raw.trackId || !raw.trackName || !raw.artistName) {
    return null;
  }
  return {
    id: String(raw.trackId),
    title: raw.trackName,
    artist: raw.artistName,
    album: raw.collectionName ?? null,
    artworkUrl: upscaleArtwork(raw.artworkUrl100),
    previewUrl: raw.previewUrl,
    storeUrl: raw.trackViewUrl ?? '',
  };
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

  const url =
    `${SEARCH_ENDPOINT}?term=${encodeURIComponent(term)}` +
    `&media=music&entity=song&limit=${SEARCH_LIMIT}`;

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Music search failed (${response.status})`);
  }

  const body = (await response.json()) as { results?: ITunesResult[] };
  return (body.results ?? []).map(toTrack).filter((t): t is Track => t !== null);
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
