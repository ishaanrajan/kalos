-- =============================================================================
-- 0044_drake_proportional.sql
--
-- Makes Drake's unsolicited output a function of how much the humans are
-- actually using the app, rather than a fixed rate chosen against whatever
-- the activity level happened to be that week.
--
-- 0043 gave the posting job a fixed ceiling of 3 per rolling 7 days, which was
-- right while humans posted ~2.7/day. They since slowed to ~0.6/day: over the
-- four days to 2026-10-12 the humans posted twice and Drake posted four times,
-- out-posting the entire user base 2:1. A fixed ceiling is only ever "about
-- right" for the activity level it was picked against.
--
-- -----------------------------------------------------------------------------
-- Posting: ceiling becomes least(3, human posts in the last 7 days)
-- -----------------------------------------------------------------------------
--   humans post 10/wk -> Drake capped at 3   (0043's ceiling still binds)
--   humans post  2/wk -> Drake capped at 2
--   humans post  1/wk -> Drake capped at 1
--   humans post  0/wk -> Drake posts nothing
--
-- Strictly `<` the cap, so at worst he equals the humans and never exceeds
-- them. Drake's posts are safe to count this way because posting is the one
-- thing he only ever does unprompted -- there is no such thing as a reply post.
--
-- -----------------------------------------------------------------------------
-- DMs: only make unsolicited contact into an app that's actually alive
-- -----------------------------------------------------------------------------
-- 0042 gated the daily DM on any human post in the last 24h, which is binary:
-- it says nothing about how *much* the humans are posting. This adds a volume
-- floor on top of it.
--
-- It is deliberately NOT a count of Drake's own DMs, because that number is
-- not trustworthy for this purpose: drake-reply-flush writes DMs too, so
-- Drake's dm_messages rows mix unsolicited contact with legitimate replies to
-- people who messaged him first. Counting them would mean a user who chats
-- with Drake a lot *suppresses* him, which is backwards -- more human
-- engagement should permit more, not less. Same reasoning rules out counting
-- his comments (drake-comment-reply-flush writes those). So the proactive
-- channels are bounded by human volume, not by Drake's own row counts.
--
-- -----------------------------------------------------------------------------
-- Comments: unchanged, already proportional by construction
-- -----------------------------------------------------------------------------
-- drake-comment only ever comments on *today's* posts and caps itself at one a
-- day (COMMENT_CHANCE + the ceiling in drake-comment/index.ts). No human posts
-- today means nothing for it to comment on, so it self-limits already.
--
-- cron.schedule upserts by job name, so both statements below re-issue an
-- existing job in place -- no unschedule needed, unlike 0042/0043 which renamed.
-- =============================================================================

select cron.schedule(
  'drake-post-random',
  '0 * * * *',
  $$
  select net.http_post(
    url := 'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/daily-drake',
    headers := '{"Content-Type": "application/json"}'::jsonb
  )
  where random() < 0.08
    and not exists (
      select 1
      from public.posts
      where author_id = (select id from public.profiles where username = 'prosecco_daddy')
        and created_at > now() - interval '48 hours'
    )
    and (
      select count(*)
      from public.posts
      where author_id = (select id from public.profiles where username = 'prosecco_daddy')
        and created_at > now() - interval '7 days'
    ) < least(
      3,
      (
        select count(*)
        from public.posts
        where author_id <> (select id from public.profiles where username = 'prosecco_daddy')
          and created_at > now() - interval '7 days'
      )
    );
  $$
);

select cron.schedule(
  'drake-dm-daily',
  '0 17 * * *',
  $$
  select net.http_post(
    url := 'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/drake-dm',
    headers := '{"Content-Type": "application/json"}'::jsonb
  )
  where exists (
    select 1
    from public.posts p
    where p.created_at > now() - interval '24 hours'
      and p.author_id <> (select id from public.profiles where username = 'prosecco_daddy')
  )
  and (
    select count(*)
    from public.posts
    where author_id <> (select id from public.profiles where username = 'prosecco_daddy')
      and created_at > now() - interval '7 days'
  ) >= 3;
  $$
);
