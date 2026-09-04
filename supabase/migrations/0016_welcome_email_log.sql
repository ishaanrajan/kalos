-- Tracks whether welcome-email has already sent a given account its welcome
-- email -- nothing did before this, so there was no way to answer "who's
-- already gotten one" and no protection against a webhook re-fire (or a
-- manual re-run) double-sending. Service-role only: the client never reads
-- or writes this, same as push_tokens / drake_bot_photo_log.

alter table public.profiles add column if not exists welcome_emailed_at timestamptz;
