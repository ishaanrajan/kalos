import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
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
