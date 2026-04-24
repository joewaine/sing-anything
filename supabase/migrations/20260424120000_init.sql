-- Sing Anything — initial schema
-- Mirrors sing-beatles where practical but makes every table user-scoped and
-- extends the model with a `songs` (user-owned) table and a `jobs` pipeline
-- progress table. All storage buckets are private; the first path segment of
-- every object must be the user's uid.

create extension if not exists "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

create table public.songs (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  slug          text not null,
  name          text not null,
  artist        text,
  duration_ms   int,
  original_path text not null,
  status        text not null default 'queued',     -- queued|stemming|analyzing|ready|error
  error         text,
  created_at    timestamptz not null default now(),
  unique (user_id, slug)
);

create index songs_user_created_idx on public.songs(user_id, created_at desc);

create table public.phrases (
  id           uuid primary key default uuid_generate_v4(),
  song_id      uuid not null references public.songs(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  slug         text not null,
  phrase_type  text not null default 'line',        -- line|verse
  start_ms     int not null,
  end_ms       int not null,
  duration_ms  int not null,
  tempo_bpm    numeric,
  lyric_text   text,
  notes        jsonb not null,
  vocals_path  text not null,
  backing_path text,
  created_at   timestamptz not null default now(),
  unique (user_id, slug)
);

create index phrases_song_idx on public.phrases(song_id);
create index phrases_user_idx on public.phrases(user_id, created_at desc);

create table public.attempts (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  phrase_id      uuid not null references public.phrases(id) on delete cascade,
  audio_path     text not null,
  pitch_analysis jsonb,
  feedback_text  text,
  feedback_try   text,
  created_at     timestamptz not null default now()
);

create index attempts_user_created_idx on public.attempts(user_id, created_at desc);

create table public.jobs (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  song_id    uuid references public.songs(id) on delete cascade,
  stage      text not null,                           -- upload|stemming|whisper|pitch|slicing|done|error
  progress   numeric,                                 -- 0..1
  message    text,
  updated_at timestamptz not null default now()
);

create index jobs_user_updated_idx on public.jobs(user_id, updated_at desc);
create index jobs_song_idx on public.jobs(song_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security — owner-only on everything
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.songs    enable row level security;
alter table public.phrases  enable row level security;
alter table public.attempts enable row level security;
alter table public.jobs     enable row level security;

create policy "songs_own"    on public.songs
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "phrases_own"  on public.phrases
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "attempts_own" on public.attempts
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "jobs_own"     on public.jobs
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Storage — three private buckets, all namespaced by <user_id>/…
-- The Modal worker uses the service role key and bypasses these policies.
-- ─────────────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public) values
  ('originals', 'originals', false),
  ('phrases',   'phrases',   false),
  ('attempts',  'attempts',  false)
on conflict (id) do nothing;

drop policy if exists "sa_storage_insert" on storage.objects;
drop policy if exists "sa_storage_select" on storage.objects;
drop policy if exists "sa_storage_delete" on storage.objects;
drop policy if exists "sa_storage_update" on storage.objects;

create policy "sa_storage_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('originals', 'phrases', 'attempts')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "sa_storage_select" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('originals', 'phrases', 'attempts')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "sa_storage_update" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('originals', 'phrases', 'attempts')
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id in ('originals', 'phrases', 'attempts')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "sa_storage_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('originals', 'phrases', 'attempts')
    and (storage.foldername(name))[1] = auth.uid()::text
  );
