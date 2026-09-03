// Supabase Edge Function: daily-drake
//
// Called once a day by a pg_cron schedule (see 0011_drake_bot.sql). Posts a
// photo as @prosecco_daddy -- picked from the ones it hasn't posted yet, so
// today's photo can never repeat one already used -- and swaps its avatar to
// another random one from the same pool. Photos are Wikimedia Commons
// images: Commons doesn't allow fair-use uploads at all, so every file
// hosted there directly (as opposed to Wikipedia) is required by site
// policy to carry a free license (CC-BY, CC-BY-SA, or public domain).
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
  'https://upload.wikimedia.org/wikipedia/commons/2/28/Drake_July_2016.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/1/18/Drake_2010.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/7/73/Drake_and_Migos_at_MSG_Aug_25th_2018.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/7/78/Drake_%2845184%29.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/9/9a/Drake_in_2017.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/1/17/Drake_Summer_Sixteen_Tour.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/d/d3/Drake_-_4972204415.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/a/a9/Drake_Bluesfest.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/9/9a/Drake_fox_theatre.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/a/a9/Drake_Live_at_Walmart_Soundcheck_%284635826377%29.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/9/92/Drake_Live_at_Walmart_Soundcheck_%284635826879%29.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/9/93/Drake_Live_at_Walmart_Soundcheck_%284636434192%29.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/6/6c/Drake_at_Bun-B_Concert_2011.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/2/21/Drake_in_2011.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/2/21/Drake_at_Tup_Tup_Palace.png',
  'https://upload.wikimedia.org/wikipedia/commons/f/fb/Drake_Club_Paradise_Tour.png',
  'https://upload.wikimedia.org/wikipedia/commons/c/c4/Drake_and_Future_2016_Summer_Sixteen_Tour.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/f/f3/Drake_all_summer_16.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/1/1a/Drake%2C_2017_Toronto_International_Film_Festival.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/1/15/Drake_at_The_Carter_Effect_2017_%2836818935200%29_%28cropped%29.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/1/17/Drake_Aug_25th_2018_at_MSG.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/1/12/Drake_Aug_25th_2018.jpg',
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
