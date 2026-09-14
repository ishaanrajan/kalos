/// <reference types="node" />
/**
 * Checks for GIF comments (0029_comment_gif.sql).
 *
 * Comments are now either typed text or a GIF sticker, never both and never
 * neither. This exercises that against the real database, signed in as a
 * real non-privileged user -- the shape constraints are what actually
 * enforce it, not just the client's own choices.
 *
 *   npx tsx scripts/verify-gif-comments.ts
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const raw of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq === -1) continue;
  process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
}
const url = process.env.SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const c = createClient(url, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });

let failed = 0;
const check = (l: string, pass: boolean, d = '') => {
  if (!pass) failed++;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${l}${d ? `  -- ${d}` : ''}`);
};
const denied = (error: unknown, data: unknown) => !!error || data == null;

const SAMPLE_GIF = {
  giphy_id: 'abc123',
  url: 'https://example.invalid/gif.gif',
  preview_url: 'https://example.invalid/gif-preview.gif',
  width: 200,
  height: 150,
};

async function main() {
  console.log('\nGIF comments\n');

  const { error: se } = await c.auth.signInWithPassword({
    email: 'maya-dev@example.com',
    password: 'kalos2015',
  });
  if (se) throw new Error(se.message);
  const me = (await c.auth.getUser()).data.user!.id;

  const { data: own } = await admin.from('posts').select('id').eq('author_id', me).limit(1);
  const postId = own?.[0]?.id as string | undefined;
  if (!postId) {
    console.log('\nNo post to test against -- run `npm run seed` first.\n');
    process.exit(1);
  }

  const seeded: string[] = [];

  try {
    // --- body-only still works (regression) -----------------------------
    {
      const { data, error } = await c
        .from('comments')
        .insert({ post_id: postId, author_id: me, body: 'verify: text comment' })
        .select('id')
        .single();
      check('a body-only comment still inserts', !error && !!data, error?.message ?? '');
      if (data?.id) seeded.push(data.id);
    }

    // --- gif-only inserts -------------------------------------------------
    let gifCommentId: string | undefined;
    {
      const { data, error } = await c
        .from('comments')
        .insert({ post_id: postId, author_id: me, body: null, gif: SAMPLE_GIF })
        .select('id')
        .single();
      check('a gif-only comment inserts', !error && !!data, error?.message ?? '');
      if (data?.id) {
        seeded.push(data.id);
        gifCommentId = data.id;
      }
    }

    // --- both together is rejected ----------------------------------------
    {
      const { data, error } = await c
        .from('comments')
        .insert({ post_id: postId, author_id: me, body: 'verify: both', gif: SAMPLE_GIF })
        .select('id')
        .single();
      check('body + gif together is rejected', denied(error, data), error ? '' : 'comments_content_shape did not fire');
      if (data?.id) seeded.push(data.id);
    }

    // --- neither is rejected -----------------------------------------------
    {
      const { data, error } = await c
        .from('comments')
        .insert({ post_id: postId, author_id: me, body: null, gif: null })
        .select('id')
        .single();
      check('neither body nor gif is rejected', denied(error, data), error ? '' : 'comments_content_shape did not fire');
      if (data?.id) seeded.push(data.id);
    }

    // --- an incomplete gif object is rejected -------------------------------
    {
      const { width, ...incomplete } = SAMPLE_GIF;
      const { data, error } = await c
        .from('comments')
        .insert({ post_id: postId, author_id: me, body: null, gif: incomplete })
        .select('id')
        .single();
      check('an incomplete gif object is rejected', denied(error, data), error ? '' : 'comments_gif_shape did not fire');
      if (data?.id) seeded.push(data.id);
    }

    // --- home_feed's preview coalesces a gif comment's body -----------------
    if (gifCommentId) {
      const { data } = await c.rpc('home_feed', { before: null, before_id: null, lim: 50 });
      const row = ((data ?? []) as Array<{ id: string; preview_comments: Array<{ id: string; body: string }> }>).find(
        (r) => r.id === postId,
      );
      const preview = row?.preview_comments.find((p) => p.id === gifCommentId);
      check(
        "home_feed's preview_comments shows a placeholder for a gif-only comment",
        preview?.body === '[GIF]',
        preview ? `body: ${JSON.stringify(preview.body)}` : 'comment not found in preview (more than 2 comments on this post?)',
      );
    }
  } finally {
    if (seeded.length) {
      const { error } = await admin.from('comments').delete().in('id', seeded);
      if (error) console.error(`  !! could not clean up test comments: ${error.message}`);
    }
  }

  console.log(failed === 0 ? '\nGIF comments are wired correctly.\n' : `\n${failed} failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
