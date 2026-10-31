/**
 * Photos in the Halloween chat: crop -> Samhain bake -> anonymous upload.
 *
 * The object name is a bare random uuid in its own bucket. Posts use
 * "<user_id>/<uuid>.jpg", which would tell everyone who sent the photo and
 * undo the chat's anonymity. The bake re-encodes through Skia, so the EXIF
 * (GPS included) of the original never reaches the upload.
 */

import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';

import { bakeFilteredImage, prepareSource, type BakedImage } from './bake';
import { getFilter } from './filters';
import { HALLOWEEN_BUCKET } from './halloween';
import { supabase } from './supabase';
import type { CropRect, ImageSize } from './types';

const CHAT_PHOTO_EDGE = 1080;

function deleteQuietly(uris: string[]) {
  for (const uri of uris) {
    try {
      new File(uri).delete();
    } catch {
      // Already gone.
    }
  }
}

export async function prepareChatPhoto(pick: {
  uri: string;
  natural: ImageSize;
  crop: CropRect;
}): Promise<BakedImage> {
  const { source, preview } = await prepareSource(pick.uri, pick.crop, pick.natural, 64, CHAT_PHOTO_EDGE);
  try {
    return await bakeFilteredImage({
      uri: source.uri,
      filter: getFilter('Samhain'),
      strength: 1,
      preNormalized: true,
      maxEdge: CHAT_PHOTO_EDGE,
      quality: 85,
    });
  } finally {
    deleteQuietly([source.uri, preview.uri]);
  }
}

export async function uploadChatPhoto(photo: BakedImage): Promise<{ path: string; width: number; height: number }> {
  const path = `${randomUUID()}.jpg`;
  const bytes = await new File(photo.uri).bytes();
  const { error } = await supabase.storage
    .from(HALLOWEEN_BUCKET)
    .upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  return { path, width: photo.width, height: photo.height };
}

export function discardChatPhoto(photo: BakedImage) {
  deleteQuietly([photo.uri]);
}
