-- Add heartbeat_at to jobs so the worker can advertise "still alive" during
-- long stages (whisper / pitch). Idempotency check on /upload uses this
-- column's staleness instead of raw stage so a hard-crashed job doesn't
-- permanently lock the user out of re-uploading.

alter table public.jobs
  add column if not exists heartbeat_at timestamptz;

create index if not exists jobs_heartbeat_idx on public.jobs (heartbeat_at);

-- Reaper: flip jobs whose heartbeat is >10 minutes stale to error.
-- Called explicitly by the worker's idempotency check (no pg_cron in this
-- project).
create or replace function public.reap_stale_jobs() returns int
language plpgsql security definer as $$
declare reaped int;
begin
  with stale as (
    select id from public.jobs
    where stage not in ('done', 'error')
      and (heartbeat_at is null and updated_at < now() - interval '10 minutes'
           or heartbeat_at < now() - interval '10 minutes')
  )
  update public.jobs j
    set stage = 'error',
        message = coalesce(j.message, '') || ' [reaped: stale heartbeat]',
        updated_at = now()
    from stale
   where j.id = stale.id;

  get diagnostics reaped = row_count;
  return reaped;
end;
$$;

grant execute on function public.reap_stale_jobs() to authenticated, service_role;
