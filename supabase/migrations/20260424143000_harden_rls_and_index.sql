-- Harden attempts RLS (cross-tenant IDOR fix) and add the picker composite index.
--
-- 1. attempts_own previously only checked auth.uid() = user_id. Since phrase_id
--    was unchecked, an authenticated user could attach attempts to someone
--    else's phrase. Add an exists() guard so the referenced phrase must be
--    owned by the same user.
--
-- 2. The picker hot query is  eq(song_id) + eq(phrase_type) + order(start_ms).
--    Current indexes cover only (song_id) and (user_id, created_at). Add the
--    composite to accelerate the picker list.

drop policy if exists "attempts_own" on public.attempts;

create policy "attempts_own" on public.attempts
  for all to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.phrases p
      where p.id = attempts.phrase_id
        and p.user_id = auth.uid()
    )
  );

create index if not exists phrases_song_type_start_idx
  on public.phrases (song_id, phrase_type, start_ms);
