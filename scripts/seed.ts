/**
 * Kalos seed script.
 *
 *   npx tsx scripts/seed.ts
 *
 * Requires (env or a .env / .env.local file in the project root):
 *   SUPABASE_URL                 https://<ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    service_role key -- SERVER SIDE ONLY, never ship this
 *
 * What it does, in order:
 *   1. Deletes any previously seeded auth users (cascades away their profiles,
 *      posts, follows, likes and comments) and their storage folders.
 *   2. Creates 8 users with confirmed emails. The auth.users trigger from
 *      migration 0003 creates each profiles row from raw_user_meta_data.
 *   3. Downloads placeholder photos from picsum.photos and uploads them to the
 *      `photos` and `avatars` buckets so images actually render in the app.
 *   4. Inserts posts back-dated across six weeks, a follow graph, likes and
 *      comments.
 *   5. Recomputes counters, then stamps `viral_stranger` with a huge
 *      like_count.
 *
 * ---------------------------------------------------------------------------
 * THE POINT OF `viral_stranger`
 * ---------------------------------------------------------------------------
 * `viral_stranger` follows nobody, is followed by nobody, and none of their
 * posts have a single like row -- yet their newest post carries like_count in
 * the thousands and is only hours old. It is therefore the single most
 * "engaging" and most recent post in the entire database.
 *
 * It must NEVER appear in explore_feed for `ishaan`, because Explore's
 * candidate set comes only from the social graph. If it ever shows up, ranking
 * has leaked into the product. The seed asserts the graph isolation before it
 * writes anything, and prints the post id so a test can assert its absence.
 * ---------------------------------------------------------------------------
 */

/// <reference types="node" />

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(file: string) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(path.join(ROOT, '.env'));

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    [
      '',
      'Missing configuration.',
      '',
      '  SUPABASE_URL              = ' + (SUPABASE_URL ?? '(unset)'),
      '  SUPABASE_SERVICE_ROLE_KEY = ' + (SERVICE_ROLE_KEY ? '(set)' : '(unset)'),
      '',
      'Put them in .env at the project root, or export them:',
      '',
      '  export SUPABASE_URL="https://YOUR_REF.supabase.co"',
      '  export SUPABASE_SERVICE_ROLE_KEY="eyJ..."',
      '',
      'Find both in Supabase Dashboard -> Project Settings -> API.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const db: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// deterministic randomness -- same seed, same database, every time
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20150714);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;

// ---------------------------------------------------------------------------
// cast
// ---------------------------------------------------------------------------

const PASSWORD = 'kalos2015';

interface SeedUser {
  username: string;
  display_name: string;
  bio: string;
  /** The account you log in as to look at the app. */
  primary?: boolean;
  /** The control account. Deliberately outside everyone's graph. */
  isolated?: boolean;
  postCount: number;
}

const USERS: SeedUser[] = [
  {
    username: 'ishaan',
    display_name: 'Ishaan Rajan',
    bio: 'test account. mostly coffee and fire escapes.',
    primary: true,
    postCount: 6,
  },
  {
    username: 'maya.dev',
    display_name: 'Maya Okonkwo',
    bio: 'building small things. 35mm when I remember to.',
    postCount: 7,
  },
  {
    username: 'leo_analog',
    display_name: 'Leo Marchetti',
    bio: 'Portra 400 apologist',
    postCount: 6,
  },
  {
    username: 'priya.frames',
    display_name: 'Priya Nair',
    bio: 'windows, doorways, the occasional dog',
    postCount: 6,
  },
  {
    username: 'tomas_g',
    display_name: 'Tomás Guerrero',
    bio: 'mountains > everything',
    postCount: 5,
  },
  {
    username: 'nina.reads',
    display_name: 'Nina Halvorsen',
    bio: 'books, ferries, bad weather',
    postCount: 5,
  },
  {
    username: 'kwame_shoots',
    display_name: 'Kwame Boateng',
    bio: 'street. golden hour or nothing.',
    postCount: 6,
  },
  {
    username: 'viral_stranger',
    display_name: 'Viral Stranger',
    bio: 'you should not be seeing this in Explore.',
    isolated: true,
    postCount: 2,
  },
];

const PRIMARY = 'ishaan';
const ISOLATED = 'viral_stranger';

/**
 * follower -> [followees]. `viral_stranger` appears on neither side, and no
 * account within two hops of `ishaan` touches it.
 */
const FOLLOW_GRAPH: Record<string, string[]> = {
  'ishaan': ['maya.dev', 'leo_analog', 'priya.frames'],
  'maya.dev': ['ishaan', 'leo_analog', 'nina.reads', 'kwame_shoots'],
  'leo_analog': ['ishaan', 'maya.dev', 'kwame_shoots'],
  'priya.frames': ['ishaan', 'tomas_g', 'nina.reads'],
  'tomas_g': ['priya.frames', 'nina.reads'],
  'nina.reads': ['maya.dev', 'kwame_shoots'],
  'kwame_shoots': ['leo_analog', 'nina.reads'],
  'viral_stranger': [],
};

const FILTERS = [
  'Normal', 'Valencia', 'X-Pro II', 'Nashville', 'Amaro', 'Rise', 'Hudson',
  'Lo-Fi', 'Earlybird', 'Sutro', 'Toaster', 'Brannan', 'Inkwell', 'Willow',
  'Mayfair', 'Sierra', 'Kelvin', 'Hefe', '1977', 'Walden',
];

const CAPTIONS = [
  'golden hour did most of the work here',
  'no filter (a lie)',
  'found this on the walk home',
  'sunday',
  'roll #14, frame 9',
  'the light in this stairwell is unreasonable',
  'been sitting on this one for a month',
  'my flatmate says this is the best one. my flatmate is wrong.',
  'coffee number three',
  'six hours on a train for this',
  'shot this, then it rained for two days',
  'square crop or nothing',
  'last one from the roll, promise',
  'somewhere north',
  'this used to be a laundromat',
  'the dog was not interested',
  'blue hour, cold hands',
  'testing a new-to-me lens',
  null,
  null,
];

const COMMENT_BODIES = [
  'this is unreal',
  'ok the colours 😍',
  'where is this??',
  'stop it',
  'the grain on this one',
  'saving this for later',
  'best one this week',
  'need a print of this',
  'how did you get the sky like that',
  'yesss',
  'this belongs on a wall',
  'ugh so good',
  'the composition here is doing a lot',
  'genuinely perfect',
];

const ASPECTS: Array<{ w: number; h: number }> = [
  { w: 1080, h: 1080 }, // classic square, the 2015 default
  { w: 1080, h: 1080 },
  { w: 1080, h: 1080 },
  { w: 1080, h: 1350 }, // 4:5
  { w: 1080, h: 810 },  // 4:3
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

function slugEmail(username: string): string {
  return `${username.replace(/[._]/g, '-')}@example.com`;
}

async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const wait = 400 * 2 ** i;
      console.warn(`   retrying ${label} (attempt ${i + 2}/${tries}) after ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(`${label} failed after ${tries} attempts: ${String(lastErr)}`);
}

async function downloadImage(seed: string, w: number, h: number): Promise<Blob> {
  const url = `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`;
  return withRetry(`download ${seed}`, async () => {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength < 1024) throw new Error(`suspiciously small image for ${url}`);
    return new Blob([bytes], { type: 'image/jpeg' });
  });
}

async function uploadImage(
  bucket: 'photos' | 'avatars',
  userId: string,
  bytes: Blob,
): Promise<string> {
  // Key layout enforced by the storage RLS policies: {user_id}/{uuid}.jpg
  const key = `${userId}/${randomUUID()}.jpg`;
  await withRetry(`upload ${bucket}/${key}`, async () => {
    const { error } = await db.storage
      .from(bucket)
      .upload(key, bytes, { contentType: 'image/jpeg', upsert: true });
    if (error) throw error;
  });
  return key;
}

function must<T>(label: string, res: { data: T; error: unknown }): T {
  if (res.error) {
    throw new Error(`${label}: ${JSON.stringify(res.error)}`);
  }
  return res.data;
}

// ---------------------------------------------------------------------------
// 0. sanity-check the graph before touching the database
// ---------------------------------------------------------------------------

function assertIsolation() {
  const primaryFollowees = FOLLOW_GRAPH[PRIMARY] ?? [];

  if (FOLLOW_GRAPH[ISOLATED]?.length) {
    throw new Error(`${ISOLATED} must follow nobody`);
  }
  for (const [follower, followees] of Object.entries(FOLLOW_GRAPH)) {
    if (followees.includes(ISOLATED)) {
      throw new Error(`${follower} must not follow ${ISOLATED}`);
    }
  }
  // Two-hop reachability check: nobody ishaan follows may follow the isolate.
  for (const f of primaryFollowees) {
    if ((FOLLOW_GRAPH[f] ?? []).includes(ISOLATED)) {
      throw new Error(`${f} is followed by ${PRIMARY} and must not follow ${ISOLATED}`);
    }
  }
  const names = new Set(USERS.map((u) => u.username));
  for (const [follower, followees] of Object.entries(FOLLOW_GRAPH)) {
    if (!names.has(follower)) throw new Error(`unknown follower ${follower}`);
    for (const fe of followees) {
      if (!names.has(fe)) throw new Error(`unknown followee ${fe}`);
      if (fe === follower) throw new Error(`self-follow ${follower}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. wipe previous seed
// ---------------------------------------------------------------------------

async function findExistingUser(email: string) {
  let page = 1;
  const perPage = 200;
  for (;;) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < perPage) return null;
    page += 1;
  }
}

async function emptyStorageFolder(bucket: 'photos' | 'avatars', userId: string) {
  const { data, error } = await db.storage.from(bucket).list(userId, { limit: 1000 });
  if (error || !data?.length) return;
  const keys = data.map((o) => `${userId}/${o.name}`);
  await db.storage.from(bucket).remove(keys);
}

async function wipe() {
  console.log('\n[1/6] Removing any previous seed...');
  for (const u of USERS) {
    const existing = await findExistingUser(slugEmail(u.username));
    if (!existing) continue;
    await emptyStorageFolder('photos', existing.id);
    await emptyStorageFolder('avatars', existing.id);
    const { error } = await db.auth.admin.deleteUser(existing.id, false);
    if (error) throw new Error(`deleteUser ${u.username}: ${error.message}`);
    console.log(`   removed @${u.username}`);
  }
}

// ---------------------------------------------------------------------------
// 2. create users
// ---------------------------------------------------------------------------

interface CreatedUser extends SeedUser {
  id: string;
  email: string;
  avatar_path: string | null;
}

async function createUsers(): Promise<Map<string, CreatedUser>> {
  console.log('\n[2/6] Creating users + profiles...');
  const out = new Map<string, CreatedUser>();

  for (const u of USERS) {
    const email = slugEmail(u.username);
    const { data, error } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: {
        username: u.username,
        display_name: u.display_name,
        bio: u.bio,
      },
    });
    if (error || !data.user) {
      throw new Error(`createUser ${u.username}: ${error?.message ?? 'no user returned'}`);
    }
    const id = data.user.id;

    // The auth.users trigger already inserted the profile. Upload an avatar and
    // patch the row (also acts as a check that the trigger fired).
    const avatarBytes = await downloadImage(`kalos-avatar-${u.username}`, 320, 320);
    const avatar_path = await uploadImage('avatars', id, avatarBytes);

    const { data: profile, error: pErr } = await db
      .from('profiles')
      .update({ avatar_path, display_name: u.display_name, bio: u.bio })
      .eq('id', id)
      .select('id, username')
      .single();

    if (pErr || !profile) {
      throw new Error(
        `profile for ${u.username} not found -- did migration 0003 (on_auth_user_created) run? ${pErr?.message ?? ''}`,
      );
    }
    if (profile.username !== u.username) {
      throw new Error(
        `username mismatch for ${u.username}: trigger produced "${profile.username}". ` +
          `A stale profile row is probably squatting the name.`,
      );
    }

    out.set(u.username, { ...u, id, email, avatar_path });
    console.log(`   @${u.username.padEnd(15)} ${id}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. posts
// ---------------------------------------------------------------------------

interface SeededPost {
  id: string;
  author: string;
  authorId: string;
  createdAtMs: number;
}

async function createPosts(users: Map<string, CreatedUser>): Promise<SeededPost[]> {
  console.log('\n[3/6] Uploading photos + inserting posts...');
  const all: SeededPost[] = [];

  for (const u of USERS) {
    const user = users.get(u.username)!;
    const rows: Record<string, unknown>[] = [];

    for (let i = 0; i < u.postCount; i++) {
      const aspect = pick(ASPECTS);
      const bytes = await downloadImage(`kalos-${u.username}-${i}`, aspect.w, aspect.h);
      const image_path = await uploadImage('photos', user.id, bytes);

      // Spread posts across the last six weeks. The isolate's newest post is
      // only hours old so it would sit at the very top of Explore if the
      // graph filter ever regressed.
      let msAgo: number;
      if (u.isolated) {
        msAgo = i === 0 ? 6 * HOUR : 3 * DAY;
      } else {
        const slot = (i + rand()) / u.postCount;
        msAgo = Math.round(slot * 42 * DAY + rand() * 8 * HOUR + HOUR);
      }

      const id = randomUUID();
      rows.push({
        id,
        author_id: user.id,
        image_path,
        width: aspect.w,
        height: aspect.h,
        caption: u.isolated
          ? i === 0
            ? 'you cannot buy your way into someone else’s feed'
            : 'still not in your Explore'
          : pick(CAPTIONS),
        filter_name: chance(0.85) ? pick(FILTERS) : null,
        created_at: iso(msAgo),
      });
      all.push({ id, author: u.username, authorId: user.id, createdAtMs: NOW - msAgo });
    }

    must(`insert posts for ${u.username}`, await db.from('posts').insert(rows).select('id'));
    console.log(`   @${u.username.padEnd(15)} ${rows.length} posts`);
  }

  return all;
}

// ---------------------------------------------------------------------------
// 4. follows
// ---------------------------------------------------------------------------

async function createFollows(users: Map<string, CreatedUser>) {
  console.log('\n[4/6] Building the follow graph...');
  const rows: Record<string, unknown>[] = [];

  for (const [follower, followees] of Object.entries(FOLLOW_GRAPH)) {
    for (const followee of followees) {
      rows.push({
        follower_id: users.get(follower)!.id,
        followee_id: users.get(followee)!.id,
        created_at: iso(Math.round((10 + rand() * 50) * DAY)),
      });
    }
  }

  must('insert follows', await db.from('follows').insert(rows).select('follower_id'));
  console.log(`   ${rows.length} edges, @${ISOLATED} on neither side`);
}

// ---------------------------------------------------------------------------
// 5. likes + comments
// ---------------------------------------------------------------------------

async function createEngagement(users: Map<string, CreatedUser>, posts: SeededPost[]) {
  console.log('\n[5/6] Adding likes + comments...');

  const likeRows: Record<string, unknown>[] = [];
  const commentRows: Record<string, unknown>[] = [];
  const seenLike = new Set<string>();

  for (const post of posts) {
    // Nothing at all touches the isolate: no like rows, no comment rows.
    if (post.author === ISOLATED) continue;

    for (const u of USERS) {
      if (u.username === post.author) continue;
      if (u.isolated) continue; // the isolate never engages either

      const follows = (FOLLOW_GRAPH[u.username] ?? []).includes(post.author);
      // People like posts by accounts they follow far more often. This is only
      // about producing plausible data -- nothing reads like_count to rank.
      const p = follows ? 0.62 : 0.14;
      if (!chance(p)) continue;

      const key = `${u.username}|${post.id}`;
      if (seenLike.has(key)) continue;
      seenLike.add(key);

      const lag = Math.round(rand() * Math.min(3 * DAY, Math.max(HOUR, NOW - post.createdAtMs)));
      likeRows.push({
        user_id: users.get(u.username)!.id,
        post_id: post.id,
        created_at: new Date(Math.min(post.createdAtMs + lag, NOW - 60_000)).toISOString(),
      });

      if (chance(0.22)) {
        commentRows.push({
          id: randomUUID(),
          post_id: post.id,
          author_id: users.get(u.username)!.id,
          body: pick(COMMENT_BODIES),
          created_at: new Date(Math.min(post.createdAtMs + lag + HOUR, NOW - 30_000)).toISOString(),
        });
      }
    }
  }

  // Guarantee the primary account has activity to look at.
  const ishaanPosts = posts.filter((p) => p.author === PRIMARY);
  for (const p of ishaanPosts.slice(0, 3)) {
    for (const fan of ['maya.dev', 'leo_analog', 'priya.frames']) {
      const key = `${fan}|${p.id}`;
      if (seenLike.has(key)) continue;
      seenLike.add(key);
      likeRows.push({
        user_id: users.get(fan)!.id,
        post_id: p.id,
        created_at: new Date(Math.min(p.createdAtMs + 2 * HOUR, NOW - 60_000)).toISOString(),
      });
    }
  }

  // Guarantee the Activity tab has a comment on it, not just likes.
  const newestIshaanPost = ishaanPosts.sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
  if (newestIshaanPost) {
    for (const [i, fan] of ['maya.dev', 'leo_analog'].entries()) {
      commentRows.push({
        id: randomUUID(),
        post_id: newestIshaanPost.id,
        author_id: users.get(fan)!.id,
        body: i === 0 ? 'this is the one' : 'ok but the light though',
        created_at: new Date(
          Math.min(newestIshaanPost.createdAtMs + (i + 1) * HOUR, NOW - 45_000),
        ).toISOString(),
      });
    }
  }

  // Guarantee at least one 'liked_by' reason exists in Explore for ishaan:
  // ishaan's followees liking posts by accounts ishaan does NOT follow.
  const secondHopAuthors = ['tomas_g', 'nina.reads', 'kwame_shoots'];
  for (const author of secondHopAuthors) {
    const target = posts.filter((p) => p.author === author).sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
    if (!target) continue;
    for (const liker of ['maya.dev', 'leo_analog', 'priya.frames']) {
      const key = `${liker}|${target.id}`;
      if (seenLike.has(key)) continue;
      seenLike.add(key);
      likeRows.push({
        user_id: users.get(liker)!.id,
        post_id: target.id,
        created_at: new Date(Math.min(target.createdAtMs + 3 * HOUR, NOW - 60_000)).toISOString(),
      });
    }
  }

  // Paranoia: assert nothing points at the isolate before writing.
  const isolatedPostIds = new Set(posts.filter((p) => p.author === ISOLATED).map((p) => p.id));
  const isolatedId = users.get(ISOLATED)!.id;
  for (const r of likeRows) {
    if (isolatedPostIds.has(r.post_id as string)) {
      throw new Error(`refusing to seed: a like points at a ${ISOLATED} post`);
    }
    if (r.user_id === isolatedId) throw new Error(`refusing to seed: ${ISOLATED} liked something`);
  }

  for (let i = 0; i < likeRows.length; i += 500) {
    must('insert likes', await db.from('likes').insert(likeRows.slice(i, i + 500)).select('post_id'));
  }
  for (let i = 0; i < commentRows.length; i += 500) {
    must('insert comments', await db.from('comments').insert(commentRows.slice(i, i + 500)).select('id'));
  }

  console.log(`   ${likeRows.length} likes, ${commentRows.length} comments`);
}

// ---------------------------------------------------------------------------
// 6. counters + the viral decoy
// ---------------------------------------------------------------------------

async function finalise(users: Map<string, CreatedUser>, posts: SeededPost[]) {
  console.log('\n[6/6] Recomputing counters...');
  const { error: rpcErr } = await db.rpc('recompute_counters');
  if (rpcErr) {
    console.warn(`   recompute_counters unavailable (${rpcErr.message}); trigger values kept.`);
  }

  // AFTER the recompute, otherwise it would be reset to the real (zero) count.
  const viralPost = posts
    .filter((p) => p.author === ISOLATED)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)[0]!;

  must(
    'stamp viral counters',
    await db
      .from('posts')
      .update({ like_count: 8423, comment_count: 512 })
      .eq('id', viralPost.id)
      .select('id'),
  );

  must(
    'stamp viral follower_count',
    await db
      .from('profiles')
      .update({ follower_count: 41207 })
      .eq('id', users.get(ISOLATED)!.id)
      .select('id'),
  );

  return viralPost;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  assertIsolation();

  console.log(`\nSeeding Kalos at ${SUPABASE_URL}`);

  await wipe();
  const users = await createUsers();
  const posts = await createPosts(users);
  await createFollows(users);
  await createEngagement(users, posts);
  const viralPost = await finalise(users, posts);

  const { data: counts } = await db
    .from('profiles')
    .select('username, post_count, follower_count, following_count')
    .order('username');

  const line = '─'.repeat(72);
  console.log(`\n${line}`);
  console.log('SEED COMPLETE');
  console.log(line);
  console.log(`\nEvery account uses the same password:  ${PASSWORD}\n`);
  console.log('  LOG IN AS THIS ONE:');
  console.log(`    email     ${slugEmail(PRIMARY)}`);
  console.log(`    password  ${PASSWORD}\n`);
  console.log('  Other accounts:');
  for (const u of USERS) {
    if (u.username === PRIMARY) continue;
    console.log(`    @${u.username.padEnd(15)} ${slugEmail(u.username)}`);
  }

  console.log('\n  Profiles:');
  console.log(`    ${'username'.padEnd(16)} ${'posts'.padStart(6)} ${'followers'.padStart(10)} ${'following'.padStart(10)}`);
  for (const c of counts ?? []) {
    console.log(
      `    ${String(c.username).padEnd(16)} ${String(c.post_count).padStart(6)} ` +
        `${String(c.follower_count).padStart(10)} ${String(c.following_count).padStart(10)}`,
    );
  }

  console.log(`\n  @${PRIMARY} follows: ${(FOLLOW_GRAPH[PRIMARY] ?? []).join(', ')}`);
  console.log(
    `  Explore for @${PRIMARY} should surface only: tomas_g, nina.reads, kwame_shoots`,
  );

  console.log(`\n${line}`);
  console.log('VERIFICATION FIXTURE');
  console.log(line);
  console.log(`  @${ISOLATED} is followed by nobody, follows nobody, and has zero like rows.`);
  console.log(`  Its newest post is 6 hours old with like_count = 8423.`);
  console.log(`  Decoy post id:   ${viralPost.id}`);
  console.log(`  Decoy author id: ${users.get(ISOLATED)!.id}`);
  console.log(`\n  Assert that explore_feed() for @${PRIMARY} NEVER returns that post id.`);
  console.log(`${line}\n`);
}

main().catch((err) => {
  console.error('\nSeed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
