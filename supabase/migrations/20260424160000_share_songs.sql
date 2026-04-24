-- Open up songs + phrases for shared read access — every authenticated user
-- sees everyone's uploads. Writes (insert/update/delete) stay owner-only so
-- only the uploader can rename or remove their own songs. Attempts and jobs
-- remain fully private (each user's recordings and pipeline progress are
-- their own).

drop policy if exists "songs_own" on public.songs;
create policy "songs_select_all" on public.songs
  for select to authenticated using (true);
create policy "songs_insert_own" on public.songs
  for insert to authenticated with check (auth.uid() = user_id);
create policy "songs_update_own" on public.songs
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "songs_delete_own" on public.songs
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "phrases_own" on public.phrases;
create policy "phrases_select_all" on public.phrases
  for select to authenticated using (true);
create policy "phrases_insert_own" on public.phrases
  for insert to authenticated with check (auth.uid() = user_id);
create policy "phrases_update_own" on public.phrases
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "phrases_delete_own" on public.phrases
  for delete to authenticated using (auth.uid() = user_id);

-- With phrases shared, attempts just need to reference SOME existing phrase
-- (not necessarily one owned by the attempt's author). The attempt row
-- itself is still owner-only.
drop policy if exists "attempts_own" on public.attempts;
create policy "attempts_own" on public.attempts
  for all to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.phrases p where p.id = attempts.phrase_id
    )
  );

-- Relax SELECT on the phrases bucket only — readers need signed URLs for
-- shared vocal + backing clips. `originals` and `attempts` buckets stay
-- owner-only (uploads and personal recordings are private).
drop policy if exists "sa_storage_select" on storage.objects;
create policy "sa_storage_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'phrases'
    or (
      bucket_id in ('originals', 'attempts')
      and (storage.foldername(name))[1] = auth.uid()::text
    )
  );
