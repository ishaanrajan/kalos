# Kalos

Instagram, circa 2015.

A photo app built around the thing the original got right: you see photos from the people you follow, in the order they posted them. Then you run out, and you go do something else.

No Stories. No Reels. No Shopping. No ranked feed. No Explore page tuned to keep you scrolling.

## What's deliberately not here

This is the whole point, so it's worth being explicit about:

- **No ranking, anywhere.** Every list in the app is `ORDER BY created_at DESC`. There is no engagement score, no predicted-interest model, no "suggested for you." `like_count` never appears in an `ORDER BY` clause in this codebase.
- **Explore is your social graph, not an algorithm.** It shows posts that someone you follow liked, and posts by people your follows follow. That's the entire candidate set. A viral post from a stranger three hops away doesn't appear, no matter how well it's doing — it isn't in the graph, so it isn't in the query.
- **The feed ends.** When you've seen everything, you get "You're all caught up." No infinite scroll, no backfilling with strangers to keep the list from running out.
- **No engagement notifications.** Activity is a chronological log of things people actually did to your posts. The app never invents a reason to pull you back in.

## What is here

- Email/password accounts
- Square photos, 18 filters recreated from the 2015 set — Clarendon, Valencia, X-Pro II, Lo-Fi, Nashville, 1977, Inkwell and the rest — with a strength slider
- A chronological feed of the people you follow
- Explore, sourced purely from your social graph, labelled with *why* you're seeing something ("Liked by maya")
- Double-tap to like, comments, profile grids, follow/unfollow
- Account search

## Stack

| | |
|---|---|
| App | Expo SDK 57, React Native 0.86, TypeScript |
| Routing | expo-router |
| Backend | Supabase — Postgres, Auth, Storage |
| Filters | @shopify/react-native-skia (colour matrices + blend-mode overlays) |
| Data | @tanstack/react-query, keyset pagination |

## Running it

You'll need a Supabase project (the free tier is plenty) and either the Expo Go app or a simulator.

```bash
npm install
cp .env.example .env      # fill in your Supabase URL and anon key
npx expo start
```

Database setup — creating the project, running the migrations in order, and seeding test data — is documented in [`supabase/README.md`](supabase/README.md).

Once seeded, sign in as one of the seeded accounts and you'll have a populated feed and a real social graph to explore.

## Layout

```
app/            Screens (expo-router file-based routes)
components/     Presentational components — props in, callbacks out
lib/            Supabase client, auth context, queries, filter engine
supabase/       Migrations: schema, RLS policies, triggers, feed functions
scripts/        Seed script
```

The two feed queries live in `supabase/migrations/0006_feed_functions.sql`. If you want to understand what this app is, read those.

## Licence

MIT
