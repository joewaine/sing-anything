-- Section-aware phrase metadata.
--
-- The worker now emits one phrase per detected song section
-- (intro / verse / chorus / bridge / outro) instead of arbitrary 3-5-line
-- "verse" groupings. Multiple verses or choruses get distinguished by
-- `section_index` (1-based occurrence within their label), so the picker
-- can render "Verse 2" / "Chorus 3" without recomputing it client-side.
--
-- Backfill is a no-op: existing rows get section_index NULL and continue
-- to render fine — the picker treats NULL as "no number badge".

alter table public.phrases
  add column if not exists section_index int;
