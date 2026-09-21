-- =============================================================================
-- 0040_cron_health.sql
--
-- Two things, both prompted by drake-comment-reply-flush-every-minute going
-- silently dead for the second time (the first was 0030):
--
--  1. Re-issue the schedule -- same fix as 0030. cron.schedule() upserts by
--     name, so this re-registers the job whatever state it was actually in,
--     and this file is safe to re-run any time it goes quiet again.
--
--  2. cron_health(): a service-role-only RPC that exposes what pg_cron and
--     pg_net have actually been doing, over the REST API. Both live in
--     schemas PostgREST doesn't serve (cron, net), so until now the only way
--     to tell "job deregistered" from "job firing but the function failing"
--     from "job fine, pg_net not delivering" was the SQL editor -- and both
--     outages were diagnosed by guessing from the symptom instead. Next time:
--
--       curl -X POST "$SUPABASE_URL/rest/v1/rpc/cron_health" \
--         -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
--         -H "Content-Type: application/json" -d '{}'
--
--     Returns { jobs, recent_runs, recent_http }: every registered job with
--     its schedule, active flag and last start time; the most recent
--     job_run_details rows (status + return_message per run); and the most
--     recent pg_net responses (HTTP status + the start of the function's
--     reply body). A job missing from `jobs` was deregistered; present with
--     active=false was disabled; present and active but with no recent run is
--     the launcher not picking it up; runs succeeding with HTTP non-200s in
--     recent_http is the function itself failing.
--
--     security definer (owned by postgres, which is what the SQL editor runs
--     as) is what lets it read cron.* and net.* at all. Execute is granted to
--     service_role only: the output includes every job's command text and
--     every HTTP response body, none of which a client has any business
--     seeing. Nothing in the app calls this -- it's an operator tool.
-- =============================================================================

select cron.schedule(
  'drake-comment-reply-flush-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://snmnhlxletlgeorzwbvt.supabase.co/functions/v1/drake-comment-reply-flush',
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  $$
);

drop function if exists public.cron_health(int);
create function public.cron_health(lim int default 30)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with bounded as (
    select greatest(1, least(coalesce(lim, 30), 200)) as n
  ),
  runs as (
    select d.jobid, j.jobname, d.status, d.return_message, d.start_time, d.end_time
    from cron.job_run_details d
    left join cron.job j on j.jobid = d.jobid
    order by d.start_time desc
    limit (select n from bounded)
  ),
  http as (
    select r.id, r.status_code, r.timed_out, r.error_msg, r.created,
           left(r.content, 160) as content
    from net._http_response r
    order by r.created desc
    limit (select n from bounded)
  )
  select jsonb_build_object(
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'jobid',    j.jobid,
        'jobname',  j.jobname,
        'schedule', j.schedule,
        'active',   j.active,
        'last_run', (select max(d.start_time) from cron.job_run_details d where d.jobid = j.jobid)
      ) order by j.jobname)
      from cron.job j
    ), '[]'::jsonb),
    'recent_runs', coalesce((select jsonb_agg(to_jsonb(runs) order by runs.start_time desc) from runs), '[]'::jsonb),
    'recent_http', coalesce((select jsonb_agg(to_jsonb(http) order by http.created desc) from http), '[]'::jsonb)
  );
$$;

revoke all on function public.cron_health(int) from public, anon, authenticated;
grant execute on function public.cron_health(int) to service_role;
