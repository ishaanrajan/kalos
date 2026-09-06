// Supabase Edge Function: daily-drake
//
// Called once a day by a pg_cron schedule (see 0011_drake_bot.sql). Posts a
// photo as @prosecco_daddy -- picked from the ones it hasn't posted yet, so
// today's photo can never repeat one already used -- and swaps its avatar to
// another random one from the same pool. Photos are the account owner's own
// curated set, pre-uploaded to the `photos` bucket under the bot's own user
// folder (photos/<bot_id>/source-N.jpg) rather than fetched from Wikimedia
// Commons -- same upload-then-insert flow either way, just a different
// source for the bytes.
//
// Posts never get an explicit width/height (posts.width/height default to
// 1080x1080 -- see 0002_schema.sql), so every source photo displays as a
// perfect square regardless of its real aspect ratio. Cropping to that
// square happens client-side (expo-image's `contentFit="cover"`, which
// centers by default -- neither PhotoGrid nor PostCard override
// `contentPosition`), so an off-center crop isn't something this function
// controls, but it's also not something it needs to: the default already
// centers it.
//
// Deploy via Dashboard -> Edge Functions -> New Function (paste this file),
// name it exactly `daily-drake`. Turn off "Enforce JWT verification" the
// same way as the other two functions -- pg_cron calls it the same way a
// Database Webhook does, with no user JWT to verify.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(supabaseUrl, serviceRoleKey);

const BOT_USERNAME = 'prosecco_daddy';

const PHOTOS = [
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-0.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-1.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-2.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-3.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-4.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-5.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-6.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-7.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-8.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-9.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-10.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-11.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-12.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-13.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-14.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-15.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-16.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-17.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-18.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-19.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-20.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-21.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-22.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-23.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-24.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-25.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-26.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-27.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-28.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-29.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-30.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-31.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-32.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-33.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-34.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-35.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-36.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-37.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-38.jpg',
  'https://snmnhlxletlgeorzwbvt.supabase.co/storage/v1/object/public/photos/b6d198a2-5079-4d94-a17d-298448e9da6d/source-39.jpg',
];

const CAPTIONS = [
  'started from the bottom, still here',
  'no new friends, just new fits',
  'certified lover boy behavior',
  'in my feelings again',
  'views from the 6',
  'prosecco o’clock',
  'another one for the vibes',
  null,
  null,
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { 'User-Agent': 'kalos-daily-drake/1.0' } });
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Picks a photo that hasn't been posted yet. Once every photo in PHOTOS has
// been used, clears the log and starts a fresh cycle -- rather than quietly
// falling back to uniform-random (which is what let the same photo post
// twice in the first place).
async function pickUnusedPhoto(): Promise<string> {
  const { data: used, error } = await db.from('drake_bot_photo_log').select('source_url');
  if (error) {
    console.error('photo log read failed, falling back to plain random', error);
    return pickRandom(PHOTOS);
  }
  const usedSet = new Set((used ?? []).map((r) => r.source_url));
  let unused = PHOTOS.filter((url) => !usedSet.has(url));
  if (unused.length === 0) {
    await db.from('drake_bot_photo_log').delete().neq('source_url', '');
    unused = PHOTOS;
  }
  return pickRandom(unused);
}

Deno.serve(async () => {
  const { data: bot, error: botErr } = await db
    .from('profiles')
    .select('id')
    .eq('username', BOT_USERNAME)
    .single();
  if (botErr || !bot) {
    console.error('bot account not found', botErr);
    return new Response('bot not found', { status: 200 });
  }

  const postUrl = await pickUnusedPhoto();
  const avatarUrl = pickRandom(PHOTOS);
  const caption = pickRandom(CAPTIONS);

  // Post a new photo.
  const postBytes = await fetchBytes(postUrl);
  const postPath = `${bot.id}/${crypto.randomUUID()}.jpg`;
  const { error: uploadErr } = await db.storage
    .from('photos')
    .upload(postPath, postBytes, { contentType: 'image/jpeg', upsert: false });
  if (uploadErr) {
    console.error('photo upload failed', uploadErr);
    return new Response('upload failed', { status: 502 });
  }
  const { error: insertErr } = await db.from('posts').insert({
    author_id: bot.id,
    image_path: postPath,
    caption,
  });
  if (insertErr) {
    console.error('post insert failed', insertErr);
    return new Response('insert failed', { status: 502 });
  }

  // Only log the photo as used once it's actually posted -- a failed
  // upload/insert above should be retryable with the same photo next run.
  const { error: logErr } = await db.from('drake_bot_photo_log').insert({ source_url: postUrl });
  if (logErr) console.error('photo log insert failed (post still went out)', logErr);

  // Swap the avatar too.
  const avatarBytes = await fetchBytes(avatarUrl);
  const avatarPath = `${bot.id}/${crypto.randomUUID()}.jpg`;
  const { error: avatarUploadErr } = await db.storage
    .from('avatars')
    .upload(avatarPath, avatarBytes, { contentType: 'image/jpeg', upsert: false });
  if (!avatarUploadErr) {
    await db.from('profiles').update({ avatar_path: avatarPath }).eq('id', bot.id);
  } else {
    console.error('avatar upload failed (post still went out)', avatarUploadErr);
  }

  return new Response('posted', { status: 200 });
});
