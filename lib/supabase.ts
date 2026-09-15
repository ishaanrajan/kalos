import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import type { Session } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase config. Copy .env.example to .env and fill in ' +
      'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY, then restart the dev server.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // Required on native: there is no URL to parse a session out of.
    detectSessionInUrl: false,
  },
});

/**
 * The session auth-js has on disk, read straight from storage -- bypassing
 * getSession(), which refuses to hand back a session whose access token has
 * expired until it can reach the server to refresh it. Used only by the boot
 * path when that refresh fails on a network error: auth-js deliberately keeps
 * the stored session in that case (the refresh token is still good), and
 * the user is signed in, just offline. Anything else is a genuinely dead
 * session and comes back null.
 */
export async function readPersistedSession(): Promise<Session | null> {
  // supabase-js derives this key the same way; there is no public getter.
  const key = `sb-${new URL(supabaseUrl!).hostname.split('.')[0]}-auth-token`;
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.access_token || !parsed.refresh_token || !parsed.user?.id) return null;
    return parsed as Session;
  } catch {
    return null;
  }
}

const PHOTOS_BUCKET = 'photos';
const AVATARS_BUCKET = 'avatars';

/** Resolve a storage path (e.g. "<uid>/<uuid>.jpg") to a public CDN URL. */
export function photoUrl(path: string): string {
  return supabase.storage.from(PHOTOS_BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * For grid/thumbnail contexts (Explore, profile grids) -- resolves the small
 * derivative generated at post time, falling back to the full image for
 * posts created before thumb_path existed. Never use this for the feed or
 * post detail; those want the full-quality image.
 */
export function photoThumbUrl(post: { image_path: string; thumb_path: string | null }): string {
  return photoUrl(post.thumb_path ?? post.image_path);
}

export function avatarUrl(path: string | null): string | null {
  if (!path) return null;
  return supabase.storage.from(AVATARS_BUCKET).getPublicUrl(path).data.publicUrl;
}

export { PHOTOS_BUCKET, AVATARS_BUCKET };
