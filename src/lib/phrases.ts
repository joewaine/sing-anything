import { requireSupabase } from './supabase';
import type { Phrase, PhraseType, Song } from '../types';

/** Phrase hydrated with its parent song + freshly-signed URLs for the audio.
 *  The `phrases` bucket is private, so every playback needs a signed URL
 *  rather than the old sing-beatles getPublicUrl() shortcut. */
export type PhraseWithSong = Phrase & {
  song: Song;
  vocals_url: string;
  backing_url: string | null;
};

export type PhraseSummary = Omit<Phrase, 'notes'> & {
  song: Song;
};

const URL_TTL_SECONDS = 60 * 60; // 1h — a practice session shouldn't outlast this
// Expire cached URLs a few minutes before the real TTL so we never hand
// back a URL that's about to die in the middle of audio playback.
const URL_CACHE_BUFFER_MS = 5 * 60 * 1000;

type CachedUrl = { url: string; expiresAt: number };
const _signedUrlCache = new Map<string, CachedUrl>();

async function signUrl(path: string): Promise<string> {
  const now = Date.now();
  const cached = _signedUrlCache.get(path);
  if (cached && cached.expiresAt > now + URL_CACHE_BUFFER_MS) {
    return cached.url;
  }
  const supabase = requireSupabase();
  const { data, error } = await supabase.storage
    .from('phrases')
    .createSignedUrl(path, URL_TTL_SECONDS);
  if (error) throw new Error(`sign ${path}: ${error.message}`);
  _signedUrlCache.set(path, {
    url: data.signedUrl,
    expiresAt: now + URL_TTL_SECONDS * 1000,
  });
  return data.signedUrl;
}

// Drop the song join — PickerScreen fetches the song separately via
// getSong(songId). Joining songs(*) per phrase duplicates the same row
// N times on the wire.
export type PhraseListRow = Omit<PhraseSummary, 'song'>;

export async function listPhrases(
  songId: string,
  phraseType: PhraseType = 'line',
): Promise<PhraseListRow[]> {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('phrases')
    .select(
      'id, song_id, user_id, slug, phrase_type, start_ms, end_ms, duration_ms, tempo_bpm, lyric_text, vocals_path, backing_path',
    )
    .eq('song_id', songId)
    .eq('phrase_type', phraseType)
    .order('start_ms');
  if (error) throw error;
  return (data ?? []) as unknown as PhraseListRow[];
}

export async function fetchFullPhrase(phraseId: string): Promise<PhraseWithSong> {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('phrases')
    .select('*, song:songs(*)')
    .eq('id', phraseId)
    .single();
  if (error) throw error;
  const base = data as Phrase & { song: Song };
  const [vocals_url, backing_url] = await Promise.all([
    signUrl(base.vocals_path),
    base.backing_path ? signUrl(base.backing_path) : Promise.resolve(null),
  ]);
  return { ...base, vocals_url, backing_url };
}
