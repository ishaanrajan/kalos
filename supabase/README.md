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
| `0011_drake_bot.sql` | `pg_cron` schedule that calls the `daily-drake` Edge Function once a day — see [Drake bot](#6-drake-bot) below |
| `0012_drake_bot_photo_log.sql` | `drake_bot_photo_log` — tracks which photos `daily-drake` has already posted, so it cycles through the pool instead of repeating |

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
2. **Create four Database Webhooks.** Dashboard → **Database** → **Webhooks**
   → **Create a new hook**, once each for `dm_messages`, `likes`, `comments`,
   `follows`:
   - Events: **Insert** only
   - Type: **Supabase Edge Functions**
   - Edge Function: `notify`

That's it — no URL or auth header to fill in by hand, the Dashboard wires
those up for you. This is also why the four triggers don't live in
`0009_notifications.sql` itself: they were originally written as raw
`supabase_functions.http_request` SQL, but that fails with
`schema "supabase_functions" does not exist` on any project that has never
created a webhook through the UI before.

---

## 6. Drake bot

A joke account, `@prosecco_daddy`, that posts a Drake photo and swaps its own
avatar once a day, picked from a pool of 22 photos on Wikimedia Commons.
Same shape as push notifications: an Edge Function plus a piece of
Dashboard-only setup, here `pg_cron` instead of a Database Webhook, since
this fires on a timer rather than a table insert.

The function never repeats a photo: `drake_bot_photo_log`
(`0012_drake_bot_photo_log.sql`) tracks which of the 22 it's already posted,
and it picks only from the unposted ones each run. Once all 22 have gone
out, it clears the log itself and starts a fresh cycle.

1. **Deploy the Edge Function.** Dashboard → **Edge Functions** → **New
   Function**, name it exactly `daily-drake`, paste in
   `supabase/functions/daily-drake/index.ts`. Turn **off** "Enforce JWT
   verification" — `pg_cron` calls it the same way a Database Webhook does,
   with no user JWT to verify.
2. **Enable `pg_cron`.** Dashboard → **Database** → **Extensions** → search
   `pg_cron` → enable. (`pg_net` should already be on from step 5 above.)
3. **Run `0011_drake_bot.sql`, then `0012_drake_bot_photo_log.sql`** in the
   SQL editor. The first schedules the function to run daily at 15:30 UTC
   (~9:30am Mountain); the second creates the no-repeat tracking table —
   required, the function's first call will error without it.
4. **Test it once by hand** before trusting the schedule: SQL editor →
   `select net.http_post(url := 'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/daily-drake', headers := '{"Content-Type": "application/json"}'::jsonb);`
   — then check `@prosecco_daddy`'s profile in the app for a new post and a
   changed avatar.

To change the daily time, edit the cron expression in
`0011_drake_bot.sql` and re-run the file — `cron.schedule` upserts by job
name, so this updates the existing schedule rather than creating a second one.

---

## RPC reference

All four are `security definer`, `stable`, `set search_path = public, extensions`,
and granted to `authenticated` only (`EXECUTE` is revoked from `PUBLIC`). They
read the caller's identity from `auth.uid()`, so an anonymous caller gets an
empty result rather than everything.

### `home_feed(before timestamptz = null, before_id uuid = null, lim int = 12)`

Your posts plus the posts of everyone you follow, `(created_at, id) DESC`.
Returns the full `FeedPost` shape from `lib/types.ts`.

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

Same shape as `home_feed`, plus `reason` (`'liked_by' | 'followed_by'`) and
`reason_username`. Same cursor contract.

Candidate set: posts **not** authored by you and **not** authored by anyone you
already follow, where either an account you follow liked the post, or an account
you follow follows the author. One row per post; `'liked_by'` wins when both
apply. Ordered strictly by `(created_at, id) DESC`.

### `activity_feed(lim int = 30)`

Likes and comments on your own posts, plus new followers, newest first.
Matches the `ActivityEvent` union: a discriminated `kind` column
(`'like' | 'comment' | 'follow'`) plus nullable `post_id`, `image_path`, `body`.
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
| `posts` | any authenticated | `author_id = auth.uid()` | `author_id = auth.uid()` | `author_id = auth.uid()` |
| `follows` | any authenticated | `follower_id = auth.uid()` | — | `follower_id = auth.uid()` |
| `likes` | any authenticated | `user_id = auth.uid()` | — | `user_id = auth.uid()` |
| `comments` | any authenticated | `author_id = auth.uid()` | — | comment author **or** post author |

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
