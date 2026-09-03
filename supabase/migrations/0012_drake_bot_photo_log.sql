-- Tracks which Drake-bot source photos have already been posted, so
-- daily-drake (see supabase/functions/daily-drake/index.ts) can pick from
-- the ones it hasn't used yet instead of picking uniformly at random --
-- with a fixed-size pool, pure random repeats within days regardless of how
-- big the pool is. Once every photo has been posted once, the function
-- clears this table itself and starts a fresh cycle.
--
-- Service-role only: no client ever reads or writes this, same as
-- push_tokens (0009_notifications.sql).

create table if not exists drake_bot_photo_log (
  source_url text primary key,
  posted_at timestamptz not null default now()
);

alter table drake_bot_photo_log enable row level security;
revoke all on drake_bot_photo_log from anon, authenticated;
