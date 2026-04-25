-- Revert the shared-library policies — each user only sees their own
-- songs and phrases again. Attempts and jobs were already owner-only;
-- we don't need to touch them.

drop policy if exists "songs_select_all" on public.songs;
drop policy if exists "songs_insert_own" on public.songs;
drop policy if exists "songs_update_own" on public.songs;
drop policy if exists "songs_delete_own" on public.songs;
drop policy if exists "songs_own" on public.songs;

create policy "songs_own" on public.songs
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "phrases_select_all" on public.phrases;
drop policy if exists "phrases_insert_own" on public.phrases;
drop policy if exists "phrases_update_own" on public.phrases;
drop policy if exists "phrases_delete_own" on public.phrases;
drop policy if exists "phrases_own" on public.phrases;

create policy "phrases_own" on public.phrases
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Reset the storage SELECT policy to owner-only across the board.
drop policy if exists "sa_storage_select" on storage.objects;
create policy "sa_storage_select" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('originals', 'phrases', 'attempts')
    and (storage.foldername(name))[1] = auth.uid()::text
  );
