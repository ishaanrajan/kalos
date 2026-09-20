# Kalos — database layer

Postgres + Auth + Storage on Supabase. Everything the app reads goes through
either a plain PostgREST table query or one of four RPCs defined in
`migrations/0006_feed_functions.sql`.

## The one rule

**No engagement ranking.** Every query in this directory orders by
`created_at DESC` (tie-broken on `id DESC`). `like_count` never appears in an
`ORDER BY`. Explore's candidate set is derived purely from the social graph:
a post can only enter Explore if someone you follow liked it, or if someone you
follow follows its author. A post with 100,000 likes from outside your graph is
not in the candidate set at all.

If you are adding a query here, that constraint is the product. Do not
"improve" it.

---

## 1. Create the Supabase project

You do not need the CLI for this — the dashboard is enough.

1. Go to <https://supabase.com/dashboard> and sign in.
2. **New project**. Pick an org, name it `kalos`, choose a region close to
   you, and set a database password (save it somewhere; you will not need it
   for this app, but you will if you ever connect with `psql`).
3. Wait ~2 minutes for provisioning.
4. Open **Project Settings → API** and copy three values:
   - **Project URL** — `https://<ref>.supabase.co`
   - **anon / public** key — safe to ship in the mobile app
   - **service_role** key — **server-side only**, it bypasses RLS entirely.
     Never put this in `app/`, `components/`, or `lib/`, and never commit it.

### Auth settings

Open **Authentication → Providers → Email** and make sure **Email** is enabled.

For a test app, also open **Authentication → Sign In / Providers** (or
**Settings**, depending on dashboard version) and turn **Confirm email** *off*.
That lets you sign up from the app without clicking a link in an inbox. The
seeded accounts are created with `email_confirm: true` so they work either way.

---

## 2. Run the migrations, in order

The files are numbered and must be applied in numeric order. Each is written to
be re-runnable (`if not exists`, `create or replace`, `drop policy if exists`),
so re-applying a file after a tweak is safe.

| File | What it does |
| --- | --- |
| `0001_extensions.sql` | `citext`, `pgcrypto` |
| `0002_schema.sql` | `profiles`, `posts`, `follows`, `likes`, `comments` + indexes |
| `0003_counters.sql` | counter triggers + `auth.users` → `profiles` bootstrap |
| `0004_rls.sql` | RLS enable + every policy |
| `0005_storage.sql` | `photos` / `avatars` buckets + object policies |
| `0006_feed_functions.sql` | `home_feed`, `explore_feed`, `activity_feed`, `search_profiles` |
| `0007_revoke_default_grants.sql` | closes the default-privilege gap that let a client forge `like_count` |
| `0008_dm.sql` | `dm_messages`, `dm_inbox()` — every thread is with "ishaan" |
| `0009_notifications.sql` | `push_tokens`, `dm_messages.read_at`, `profiles.activity_read_at` — see [Push notifications](#5-push-notifications) below for the Edge Function + webhooks this depends on |
| `0011_drake_bot.sql` | `pg_cron` schedule that calls the `daily-drake` Edge Function twice a day — see [Drake bot](#6-drake-bot) below |
| `0012_drake_bot_photo_log.sql` | `drake_bot_photo_log` — tracks which photos `daily-drake` has already posted, so it cycles through the pool instead of repeating |
| `0013_drake_dm.sql` | `pg_cron` schedule that calls the `drake-dm` Edge Function every 4 hours — see [Drake DMs](#drake-dms) below |
| `0014_dm_multi_thread.sql` | `dm_messages.thread_with_id` — a thread's real identity is now (thread_user_id, thread_with_id), so a Drake DM no longer lands mixed into the ishaan thread |
| `0015_home_feed_comment_preview.sql` | `home_feed()` gains `preview_comments` — the 2 most recent comments per post, for `PostCard`'s inline preview |
| `0016_welcome_email_log.sql` | `profiles.welcome_emailed_at` — lets `welcome-email` skip an account it's already emailed |
| `0017_suggested_profiles.sql` | `suggested_profiles()` — the 5 accounts shown under the search bar before a query is typed, reusing Explore's `followed_by` graph logic |
| `0018_dm_hardening.sql` | DM fixes from a subsystem review: `thread_with_id`'s FK now cascades on delete, RLS actually enforces the "ishaan or Drake only" thread model post-0014, `my_dm_thread_previews()` replaces a full-history client-side reduction, and `dm_messages` is added to the `supabase_realtime` publication so a thread updates live |
| `0019_drake_reply.sql` | `drake_pending_replies` + a `pg_cron` schedule that flushes it every minute — see [Drake replies](#drake-replies) below |
| `0020_drake_reply_thread_with_id.sql` | Adds `drake_pending_replies.thread_with_id` — a queued reply now preserves its real thread identity instead of assuming `thread_with_id` is always the bot's own id, which broke ishaan's thread with Drake specifically (see the note in [Drake replies](#drake-replies)) |
| `0021_activity_mentions.sql` | `activity_feed()` gains a `'mention'` kind — a live scan over `comments` for `@you`, on any post, not just your own. Backfills automatically since nothing is stored, it's a query |
| `0027_dm_peer_sandbox.sql` | `dm_peer_pairs` — sandboxed peer-to-peer DMs between two non-hub accounts, starting with `alex` ↔ `cmcclel7`. RLS + `my_dm_thread_previews()` updated to recognize an allowlisted pair; add more later with a plain insert |
| `0028_music_everyone.sql` | Repeals `0025_music_ishaan_only.sql` — `posts_insert_own` goes back to a plain ownership check, so any account can post with music |
| `0029_comment_gif.sql` | `comments.gif` — GIF-only comments via GIPHY (see `lib/giphy.ts`). `comments.body` becomes nullable; `home_feed`/`activity_feed` coalesce a GIF comment's preview text to `[GIF]` |
| `0030_fix_drake_comment_reply_cron.sql` | Reschedules `drake-comment-reply-flush-every-minute`, which had silently stopped running — re-run if that job ever goes quiet again |
| `0031_post_blocks.sql` | `post_blocks` — lets one account hide their posts from a specific other account (post visibility only, not a general block). Admin-managed, no client UI yet; add a row with a plain insert |
| `0034_post_tags.sql` | `post_tags` — tagging people on a photo, positioned as fractions of the displayed frame. `home_feed`/`explore_feed` gain a `tags` column; `activity_feed` gains a `'tag'` kind. Needs a fifth `notify` webhook — see [Push notifications](#5-push-notifications) |
| `0038_comment_likes.sql` | `comment_likes` — a heart on an individual comment, separate from liking the post. Adds `comments.like_count`. Needs a sixth `notify` webhook — see [Push notifications](#5-push-notifications) |

### Option A — SQL editor (no tooling required)

1. Dashboard → **SQL Editor** → **New query**.
2. Open `supabase/migrations/0001_extensions.sql`, paste the whole file, **Run**.
3. Repeat for `0002`, `0003`, `0004`, `0005`, `0006` — one file per query, in
   order. Wait for each to succeed before starting the next.

You should see `Success. No rows returned` each time. Some files emit `NOTICE`
messages; those are informational.

### Option B — Supabase CLI

```bash
brew install supabase/tap/supabase        # or: npm i -g supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

`db push` applies every file in `supabase/migrations` in filename order and
records them in `supabase_migrations.schema_migrations`.

### If a statement fails

- **`permission denied for table objects`** while running `0005_storage.sql` —
  the file catches this and prints a `NOTICE` instead of failing. Recreate the
  four policies by hand from **Storage → Policies** on the `objects` table:
  public `SELECT` on `bucket_id in ('photos','avatars')`, and
  `INSERT`/`UPDATE`/`DELETE` for `authenticated` where
  `(storage.foldername(name))[1] = auth.uid()::text`.
- **`must be owner of relation users`** while running `0003_counters.sql` — the
  `on_auth_user_created` trigger could not be created. Run that one statement
  from the SQL editor while connected as `postgres` (the dashboard SQL editor
  already is). Without this trigger, signing up produces an auth user with no
  profile row.

### Verify

Run this in the SQL editor; all five should come back `true`:

```sql
select
  to_regclass('public.posts')                        is not null as tables_ok,
  to_regprocedure('public.home_feed(timestamptz,uuid,int)')    is not null as home_ok,
  to_regprocedure('public.explore_feed(timestamptz,uuid,int)') is not null as explore_ok,
  (select count(*) from storage.buckets where id in ('photos','avatars')) = 2 as buckets_ok,
  (select bool_and(rowsecurity) from pg_tables
     where schemaname = 'public'
       and tablename in ('profiles','posts','follows','likes','comments'))  as rls_ok;
```

---

## 3. Environment variables

Create `.env` in the **project root** (not in `supabase/`). It is already
git-ignored.

```dotenv
# Server-side only. Used by scripts/seed.ts. Never import these in the app.
SUPABASE_URL=https://YOUR_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...   # service_role, NOT anon

# Client-side. Read by the Expo app at build time.
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_REF.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...   # anon / public
```

The `EXPO_PUBLIC_*` pair is what the app itself uses; the unprefixed pair is
what the seed script uses. Keeping them separate makes it obvious which key is
allowed to reach the device.

### External APIs

Two third-party catalogs are searched directly from the device rather than
through an Edge Function -- see the doc comments in `lib/music.ts` and
`lib/giphy.ts` for why (mainly: per-IP/per-key/per-token rate limits that a
shared server-side budget would exhaust immediately).

- **Music** (`lib/music.ts`) — Apple's real Music Catalog API (MusicKit), not
  the legacy free `itunes.apple.com/search` endpoint this used to hit. That
  endpoint turned out to default to the *clean* edition of a song for search
  terms that would obviously return an explicit one (verified directly:
  "HUMBLE.", "WAP" — nothing but `cleaned` results, regardless of query
  parameters); the real catalog carries both editions as distinct resources
  with a genuine `contentRating` field, and `lib/music.ts` picks the explicit
  one when both exist.

  Needs a developer token — a JWT signed with a MusicKit private key, not an
  API key — added to `.env` as:
  ```dotenv
  EXPO_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN=...
  ```
  Apple caps a token's validity at 6 months, so this is a periodic manual
  task, not a one-time setup:

  1. **One-time**: Apple Developer account → **Certificates, Identifiers &
     Profiles → Identifiers → +** → type **Media IDs** → register one (Kalos's
     is `media.kalos.music`). Then **Keys → +**, check **Media Services
     (MusicKit, ShazamKit)**, register, and **download the `.p8` file
     immediately** — it's a one-time download; losing it means revoking the
     key and making a new one. Save it as `secrets/AuthKey_<KEY_ID>.p8`
     (`*.p8` is git-ignored — this file must never be committed). Kalos's key
     ID is `5P8H7A8FPA`; the Team ID is the same one in `AGENTS.md`
     (`C3AWB7CGFQ`).
  2. **Every ~5 months**, before the current token expires: `npx tsx
     scripts/mint-apple-music-token.ts`, paste the printed token over the
     `.env` value above, then `eas update` to both branches. It's a plain
     env var baked into the JS bundle at publish time, so rotating it never
     needs a native build.

  Catalog search and 30-second previews need only this developer token — no
  Music-User-Token, no Apple Music subscription from anyone, so this still
  runs straight from the device the same way the old iTunes-based version
  did. Unlike the iTunes endpoint's per-IP throttle, Apple doesn't publish
  exact limits for this one and it may be scoped to the token rather than
  the caller — unconfirmed, and not a concern at this app's size, but worth
  knowing if search ever starts failing for everyone at once rather than one
  device.
- **GIF comments** (`lib/giphy.ts`, `0029_comment_gif.sql`) — GIPHY's search
  API. Needs a free key from <https://developers.giphy.com>, added to `.env` as:
  ```dotenv
  EXPO_PUBLIC_GIPHY_API_KEY=...
  ```
  GIPHY's own docs expect this key to ship client-side, same as the Supabase
  anon key above. Without it, GIF search fails with a normal error message
  in the picker (not a crash).

---

## 4. Seed

```bash
npx tsx scripts/seed.ts
```

`tsx` is fetched on demand by `npx`; nothing needs to be added to
`package.json`. The script needs network access (it pulls placeholder photos
from `picsum.photos` and uploads them into the `photos` bucket, so images
actually render rather than 404).

It is idempotent: it deletes the previously seeded auth users — which cascades
away their profiles, posts, follows, likes and comments — and their storage
folders, then rebuilds everything.

It creates 8 accounts, all with the password `kalos2015`. Log in as
**`ishaan@example.com`**. The script prints the full credential list, per-profile
counts, and the verification fixture when it finishes.

### The `viral_stranger` fixture

The seed deliberately creates one account, `viral_stranger`, that:

- follows nobody and is followed by nobody,
- has **zero** rows in `likes` pointing at its posts,
- has a post that is only **6 hours old** (newest in the database),
- carries `like_count = 8423` and `follower_count = 41207`, written directly
  after the counters are recomputed.

It is therefore simultaneously the most recent and the most "engaging" content
in the database. `explore_feed()` must never return it for `ishaan`. That is the
regression test for the whole thesis — if ranking ever leaks in, this post is
what surfaces first. The seed prints its post id for the test to assert against.

---

## 5. Push notifications

`0009_notifications.sql` sets up the tables and RLS this depends on, but not
the delivery mechanism itself — that's two more pieces, both Dashboard-driven
rather than SQL, since a fresh project doesn't have the `supabase_functions`
schema that raw webhook-trigger SQL needs until you've created a webhook
through the UI at least once.

1. **Deploy the Edge Function.** Dashboard → **Edge Functions** → **New
   Function**, name it exactly `notify`, paste in
   `supabase/functions/notify/index.ts`. If it asks about **"Enforce JWT
   verification,"** turn that **off** — the webhook below calls it directly,
   with no user JWT to verify.
2. **Create six Database Webhooks.** Dashboard → **Database** → **Webhooks**
   → **Create a new hook**, once each for `dm_messages`, `likes`, `comments`,
   `follows`, `post_tags`, `comment_likes` (the last two only once their own
   migration — `0034_post_tags.sql`, `0038_comment_likes.sql` — has run each
   time: the table has to exist before a hook can be attached to it):
   - Events: **Insert** only
   - Type: **Supabase Edge Functions**
   - Edge Function: `notify`

That's it — no URL or auth header to fill in by hand, the Dashboard wires
those up for you. This is also why the triggers don't live in
`0009_notifications.sql` itself: they were originally written as raw
`supabase_functions.http_request` SQL, but that fails with
`schema "supabase_functions" does not exist` on any project that has never
created a webhook through the UI before.

---

## 6. Drake bot

A joke account, `@prosecco_daddy`, that posts a Drake photo and swaps its own
avatar twice a day, picked from a pool of 40 curated photos pre-uploaded to
the `photos` storage bucket under the bot's own user folder
(`photos/<bot_id>/source-N.jpg`) -- originally a pool of 22 Wikimedia Commons
images, swapped out for a locally-sourced set. Same shape as push
notifications: an Edge Function plus a piece of Dashboard-only setup, here
`pg_cron` instead of a Database Webhook, since this fires on a timer rather
than a table insert.

The function never repeats a photo: `drake_bot_photo_log`
(`0012_drake_bot_photo_log.sql`) tracks which it's already posted, and it
picks only from the unposted ones each run. Once every photo in the current
pool has gone out, it clears the log itself and starts a fresh cycle --
stale log entries from a previous, now-replaced pool never match anything in
the current `PHOTOS` list, so swapping the pool out (as happened here)
naturally starts a clean cycle without needing to manually clear the log.

Posts never get an explicit width/height, so every photo displays as a
perfect square (`posts.width`/`height` default to 1080x1080) regardless of
its real aspect ratio -- the crop to fill that square happens client-side
via `expo-image`'s `contentFit="cover"`, which centers by default.

1. **Deploy the Edge Function.** Dashboard → **Edge Functions** → **New
   Function**, name it exactly `daily-drake`, paste in
   `supabase/functions/daily-drake/index.ts`. Turn **off** "Enforce JWT
   verification" — `pg_cron` calls it the same way a Database Webhook does,
   with no user JWT to verify.
2. **Enable `pg_cron`.** Dashboard → **Database** → **Extensions** → search
   `pg_cron` → enable. (`pg_net` should already be on from step 5 above.)
3. **Run `0011_drake_bot.sql`, then `0012_drake_bot_photo_log.sql`** in the
   SQL editor. The first schedules the function to run twice daily, at 03:30
   and 15:30 UTC (~9:30pm and 9:30am Mountain); the second creates the
   no-repeat tracking table — required, the function's first call will error
   without it.
4. **Test it once by hand** before trusting the schedule: SQL editor →
   `select net.http_post(url := 'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/daily-drake', headers := '{"Content-Type": "application/json"}'::jsonb);`
   — then check `@prosecco_daddy`'s profile in the app for a new post and a
   changed avatar.

To change the cadence or time, edit the cron expression in
`0011_drake_bot.sql` and re-run the file — `cron.schedule` upserts by job
name, so this updates the existing schedule rather than creating a second
one. The function itself has no notion of "once a day" -- it just posts once
whenever called -- so any cron cadence works without touching
`daily-drake/index.ts`.

### Drake DMs

`@prosecco_daddy` also DMs a random account (never `ishaan` — he sees every
thread via his own inbox regardless, so excluding him just avoids a "thread
with yourself" row) every 4 hours, with a joke/lyric-flavored one-liner from
a fixed list in `supabase/functions/drake-dm/index.ts`. Same shape as the
photo bot: an Edge Function on a `pg_cron` timer.

This is the one thing in the app that writes into someone else's DM thread
other than `ishaan` — it works because the function runs on the service-role
key, which bypasses `dm_messages`' RLS entirely (see `0008_dm.sql`). The
client attributes each message to its real sender (`lib/queries.ts`'s
`useDMThread` embeds `sender:profiles`), so a Drake DM shows up correctly
labeled instead of looking like it came from `ishaan`.

1. **Deploy the Edge Function.** Dashboard → **Edge Functions** → **New
   Function**, name it exactly `drake-dm`, paste in
   `supabase/functions/drake-dm/index.ts`. Turn **off** "Enforce JWT
   verification", same as the other cron-driven functions.
2. **Run `0013_drake_dm.sql`** in the SQL editor. `pg_cron`/`pg_net` are
   already enabled from the steps above.
3. **Test it once by hand**: SQL editor →
   `select net.http_post(url := 'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/drake-dm', headers := '{"Content-Type": "application/json"}'::jsonb);`
   — then check that some account (not `ishaan`) got a new DM from
   `@prosecco_daddy`.

To change the cadence, edit the cron expression in `0013_drake_dm.sql` and
re-run it. To change what it says, edit the `MESSAGES` array in
`supabase/functions/drake-dm/index.ts` and redeploy the function.

### Drake replies

`@prosecco_daddy` also replies when a human messages *him* — an actual
Claude-generated in-character line, not another canned message, with a
randomized couple-minutes delay before it lands so it doesn't read as
instant/robotic. Two Edge Functions, same webhook-plus-cron shape used
everywhere else in this section:

- `drake-reply-generate` — Database Webhook on `dm_messages` insert (a
  second, independent webhook from `notify`'s — different concern). When a
  human writes into their thread with Drake, this fetches the last 20
  messages of that thread, calls the Claude API for a reply, and queues it
  in `drake_pending_replies` (`0019_drake_reply.sql`) with a random `send_at`
  20s–3min out. It does not send anything itself.
- `drake-reply-flush` — `pg_cron`, every minute. Sends whatever's due by
  inserting into `dm_messages` as `@prosecco_daddy`, same as `drake-dm`
  already does — which also means the existing `notify` webhook fires
  normally and the human gets a real push notification when the reply
  actually lands.

A thread's identity is the `(thread_user_id, thread_with_id)` pair, and which
slot Drake occupies depends on who's on the other end: a regular user's
thread with Drake is `(them, drake)`, but ishaan's DM screen always puts
*himself* in `thread_with_id` regardless of who he's actually talking to
(that's how his cross-user inbox is built) — so **his** thread with Drake is
`(drake, ishaan)`, the opposite slot arrangement. `drake-reply-generate`
checks both slots and preserves whichever pair the original message actually
used; `drake_pending_replies` stores the real `thread_with_id` rather than
`drake-reply-flush` assuming it's always the bot's own id
(`0020_drake_reply_thread_with_id.sql`) — get this wrong and ishaan's own
messages to Drake are silently invisible to the whole pipeline.

1. **Add one more secret.** Dashboard → **Edge Functions** → **Manage
   secrets**: `ANTHROPIC_API_KEY`, an API key from console.anthropic.com.
2. **Deploy both Edge Functions.** Dashboard → **Edge Functions** → **New
   Function**, once each for `drake-reply-generate` and `drake-reply-flush`,
   pasting in the matching file from `supabase/functions/`. Turn **off**
   "Enforce JWT verification" on both.
3. **Create the second webhook.** Dashboard → **Database** → **Webhooks** →
   **Create a new hook**, on `dm_messages`, event **Insert**, Edge Function
   `drake-reply-generate`. (This is in addition to the `notify` webhook on
   the same table from [Push notifications](#5-push-notifications) — both
   fire independently on the same insert.)
4. **Run `0019_drake_reply.sql`, then `0020_drake_reply_thread_with_id.sql`**
   in the SQL editor. `pg_cron`/`pg_net` are already enabled from the steps
   above.
5. **Test it**: DM `@prosecco_daddy` from any account — including ishaan's —
   then check `drake_pending_replies` in the Table Editor for a queued row —
   it should appear in the thread within a few minutes once
   `drake-reply-flush`'s next tick picks it up.

---

## RPC reference

All four are `security definer`, `stable`, `set search_path = public, extensions`,
and granted to `authenticated` only (`EXECUTE` is revoked from `PUBLIC`). They
read the caller's identity from `auth.uid()`, so an anonymous caller gets an
empty result rather than everything.

### `home_feed(before timestamptz = null, before_id uuid = null, lim int = 12)`

Your posts plus the posts of everyone you follow, `(created_at, id) DESC`.
Returns the full `FeedPost` shape from `lib/types.ts`, including `tags` — a
JSON array of `{ user_id, username, x, y }` for the people tagged on the
photo (`0034_post_tags.sql`), `[]` when there are none.

```ts
const { data } = await supabase.rpc('home_feed', {
  before: cursor?.before ?? null,
  before_id: cursor?.before_id ?? null,
  lim: PAGE_SIZE,
});
```

Paginate by taking the last row of the page and passing
`{ before: row.created_at, before_id: row.id }`. Both cursor args must be sent
together; if either is null the cursor is ignored and you get page one. `lim` is
clamped to 1–50.

### `explore_feed(before timestamptz = null, before_id uuid = null, lim int = 12)`

Same shape as `home_feed` (minus `preview_comments`), plus `reason`
(`'liked_by' | 'followed_by'`) and `reason_username`. Same cursor contract.

Candidate set: posts **not** authored by you and **not** authored by anyone you
already follow, where either an account you follow liked the post, or an account
you follow follows the author. One row per post; `'liked_by'` wins when both
apply. Ordered strictly by `(created_at, id) DESC`.

### `activity_feed(lim int = 30)`

Likes and comments on your own posts, new followers, @mentions of you in
comments, and photos you've been tagged on, newest first. Matches the
`ActivityEvent` union: a discriminated `kind` column
(`'like' | 'comment' | 'follow' | 'mention' | 'tag'`) plus nullable `post_id`,
`image_path`, `thumb_path`, `body`. For `'tag'` the actor is the post's author.
`actor` is a JSON object in the `Profile` shape. `lim` is clamped to 1–100.

### `search_profiles(q text, lim int = 20)`

Prefix match on `username` or `display_name`, case-insensitive. Returns the
`Profile` shape. An exact username match sorts first, then alphabetical — note
that `follower_count` is not in the `ORDER BY`. Empty `q` returns nothing.
`lim` is clamped to 1–50.

---

## Schema notes

- `profiles.username` is `citext`, uniquely indexed, and constrained to
  `^[a-z0-9._]{3,30}$` against its `::text` form — so it is stored lowercase,
  and `Bob` can never be inserted at all.
- `posts.width` / `posts.height` are `NOT NULL DEFAULT 1080` because
  `lib/types.ts` declares them as non-nullable numbers.
- Counters (`like_count`, `comment_count`, `post_count`, `follower_count`,
  `following_count`) are maintained by `AFTER INSERT/DELETE` triggers. The
  trigger functions are `SECURITY DEFINER` so that liking someone else's post
  can bump a row RLS would never let you `UPDATE` directly.
  `public.recompute_counters()` rebuilds all of them from scratch if they ever
  drift; it is granted to `service_role` only.
- Deleting a post cascades to its likes and comments. The counter triggers fire
  against an already-deleted parent row and update zero rows — harmless.

## Storage

Two public-read buckets, `photos` and `avatars`. Object keys are
`{user_id}/{uuid}.jpg`; the write policies enforce that first path segment
against `auth.uid()`. `posts.image_path` and `profiles.avatar_path` store the
bucket-relative key (`"<uuid>/<uuid>.jpg"`), not a URL — resolve it in the app
with `supabase.storage.from('photos').getPublicUrl(image_path)`.

## RLS summary

Every account is public to signed-in users in v1; that openness is what makes
Explore possible. Anonymous callers get nothing — no policy grants `anon`.

| Table | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| `profiles` | any authenticated | `id = auth.uid()` | `id = auth.uid()` | — (cascades from `auth.users`) |
| `posts` | any authenticated, minus a per-pair block (`post_blocks`, 0031) | `author_id = auth.uid()` | `author_id = auth.uid()` | `author_id = auth.uid()` |
| `follows` | any authenticated | `follower_id = auth.uid()` | — | `follower_id = auth.uid()` |
| `likes` | any authenticated | `user_id = auth.uid()` | — | `user_id = auth.uid()` |
| `comments` | any authenticated | `author_id = auth.uid()` | — | comment author **or** post author |
| `post_tags` | any authenticated, when the post itself is visible to them | post's author | — | post's author **or** the tagged account |

### Counters are not writable by clients

`UPDATE` is granted **per column**, not per table:

- `profiles`: `username`, `display_name`, `bio`, `avatar_path`
- `posts`: `caption`, `filter_name`

Everything else — `like_count`, `comment_count`, `post_count`,
`follower_count`, `following_count` — is owned by the triggers in
`0003_counters.sql`. A client that tries to write one gets
`permission denied for column`, which is the correct answer: no account can
inflate its own numbers. If you need to change what an author may edit, widen
the `grant update (...)` list in `0004_rls.sql` rather than granting table-level
`UPDATE`.
