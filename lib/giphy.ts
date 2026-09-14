/**
 * The GIF catalog for comments.
 *
 * This is the only file in the app that knows where GIFs come from, same
 * split as lib/music.ts for tracks -- everything downstream speaks Gif and
 * CommentGif.
 *
 * Source is GIPHY's search API. Unlike the iTunes catalog lib/music.ts uses,
 * this one requires an API key (EXPO_PUBLIC_GIPHY_API_KEY, client-embeddable
 * like the Supabase anon key -- GIPHY's own docs expect this key to ship in
 * client apps). Get one at developers.giphy.com.
 *
 * GIPHY's ToS requires attribution ("Powered By GIPHY") wherever their
 * content is displayed -- that's rendered by components/GifPicker.tsx, not
 * here. Results are capped to a `rating` of pg-13 as a content-safety
 * default for a small friend-group app.
 */

import type { CommentGif } from './types';

// Note: this module deliberately imports nothing from react-native or expo-*,
// same reasoning as lib/music.ts -- it can be exercised under plain Node by a
// verify script without pulling in native code.

/** A search result from the catalog, before it's attached to a comment. */
export interface Gif {
  id: string;
  /** A size-capped, displayable asset -- never GIPHY's full-resolution original. */
  url: string;
  /** A small static/looping still, for a fast first paint. */
  previewUrl: string;
  width: number;
  height: number;
}

const SEARCH_ENDPOINT = 'https://api.giphy.com/v1/gifs/search';
const SEARCH_LIMIT = 24;
const RATING = 'pg-13';

interface GiphyImage {
  url?: string;
  width?: string;
  height?: string;
}

/** The shape we actually read off a result; the real payload is much wider. */
interface GiphyResult {
  id?: string;
  images?: {
    fixed_width?: GiphyImage;
    fixed_width_small_still?: GiphyImage;
    fixed_width_still?: GiphyImage;
  };
}

function toGif(raw: GiphyResult): Gif | null {
  const asset = raw.images?.fixed_width;
  const preview = raw.images?.fixed_width_small_still ?? raw.images?.fixed_width_still;
  const width = Number(asset?.width);
  const height = Number(asset?.height);
  // A result missing a playable asset, its dimensions, or a preview still is
  // not one we can lay out or show -- it never reaches the picker.
  if (!raw.id || !asset?.url || !preview?.url || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  return { id: raw.id, url: asset.url, previewUrl: preview.url, width, height };
}

function apiKey(): string {
  const key = process.env.EXPO_PUBLIC_GIPHY_API_KEY;
  if (!key) {
    throw new Error('EXPO_PUBLIC_GIPHY_API_KEY is not set -- get one at developers.giphy.com and add it to .env');
  }
  return key;
}

/**
 * Search the catalog. `signal` is threaded through so a superseded
 * keystroke's request is actually cancelled rather than left to land out of
 * order, same as searchTracks.
 */
export async function searchGifs(query: string, signal?: AbortSignal): Promise<Gif[]> {
  const term = query.trim();
  if (!term) {
    return [];
  }

  const url =
    `${SEARCH_ENDPOINT}?api_key=${encodeURIComponent(apiKey())}` +
    `&q=${encodeURIComponent(term)}&limit=${SEARCH_LIMIT}&rating=${RATING}`;

  const response = await fetch(url, { signal });
  if (!response.ok) {
    // A bad/placeholder key returns GIPHY's own 401/403 JSON error, not a
    // network failure -- surfaced as a normal thrown error so the picker's
    // isError state shows it rather than assuming "offline".
    throw new Error(`GIF search failed (${response.status})`);
  }

  const body = (await response.json()) as { data?: GiphyResult[] };
  return (body.data ?? []).map(toGif).filter((g): g is Gif => g !== null);
}

/** Freeze a chosen GIF into the shape a comment row stores. */
export function gifToCommentGif(gif: Gif): CommentGif {
  return {
    giphy_id: gif.id,
    url: gif.url,
    preview_url: gif.previewUrl,
    width: gif.width,
    height: gif.height,
  };
}
