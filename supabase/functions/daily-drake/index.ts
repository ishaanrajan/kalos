// Supabase Edge Function: daily-drake
//
// Called once a day by a pg_cron schedule (see 0011_drake_bot.sql). Posts a
// random photo as @prosecco_daddy and swaps its avatar to another random
// one from the same pool. Photos are Wikimedia Commons images published
// under CC-BY / CC-BY-SA by their original photographers -- direct links
// below, each verified individually before being added here.
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

// Each one individually verified on Wikimedia Commons: CC-BY-2.0 or
// CC-BY-SA (2.0/3.0/4.0), photographer credited in the file's own page.
const PHOTOS = [
  'https://upload.wikimedia.org/wikipedia/commons/2/28/Drake_July_2016.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/1/18/Drake_2010.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/7/73/Drake_and_Migos_at_MSG_Aug_25th_2018.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/7/78/Drake_%2845184%29.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/9/9a/Drake_in_2017.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/1/17/Drake_Summer_Sixteen_Tour.jpg',
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

  const postUrl = pickRandom(PHOTOS);
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
