import { Platform } from 'react-native';
import { requireSupabase } from './supabase';
import { analyzeAttempt, type PitchAnalysis } from './pitch';
import type { MidiNote } from '../types';
import type { PhraseWithSong } from './phrases';

export type TakeRow = {
  id: string;
  phrase_id: string;
  audio_path: string;
  pitch_analysis: PitchAnalysis | null;
  created_at: string;
  phrase: {
    id: string;
    phrase_type: string;
    duration_ms: number;
    lyric_text: string | null;
    tempo_bpm: number | null;
    notes: MidiNote[];
    vocals_path: string;
    backing_path: string | null;
    song_id: string;
    song: {
      id: string;
      name: string;
      artist: string | null;
    };
  };
};

export async function listAttempts(): Promise<TakeRow[]> {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('attempts')
    .select(
      'id, phrase_id, audio_path, pitch_analysis, created_at, '
        + 'phrase:phrases(id, phrase_type, duration_ms, lyric_text, tempo_bpm, '
        + 'notes, vocals_path, backing_path, song_id, song:songs(id, name, artist))',
    )
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as unknown as TakeRow[];
}

export async function deleteAttempt(take: TakeRow): Promise<void> {
  const supabase = requireSupabase();
  // Best-effort: drop the audio blob first, then the row. If the
  // storage delete fails (already gone, RLS), we still try to remove
  // the row so it disappears from the list.
  try {
    await supabase.storage.from('attempts').remove([take.audio_path]);
  } catch (e) {
    console.warn('attempt audio delete failed:', e);
  }
  const { error } = await supabase.from('attempts').delete().eq('id', take.id);
  if (error) throw error;
}

export async function signTakeUrls(take: TakeRow): Promise<{
  recordingUrl: string;
  vocalsUrl: string;
  backingUrl: string | null;
}> {
  const supabase = requireSupabase();
  const sign = async (bucket: string, path: string) => {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, 60 * 60);
    if (error) throw error;
    return data.signedUrl;
  };
  const [recordingUrl, vocalsUrl, backingUrl] = await Promise.all([
    sign('attempts', take.audio_path),
    sign('phrases', take.phrase.vocals_path),
    take.phrase.backing_path ? sign('phrases', take.phrase.backing_path) : null,
  ]);
  return { recordingUrl, vocalsUrl, backingUrl };
}

export type UploadResult = {
  attemptId: string;
  audioPath: string;
  audioUri: string;
};

/**
 * Upload the audio and insert an empty attempts row — fast network-bound work.
 * Pitch analysis runs separately via `runAnalysisAndSave` so the UI can
 * transition to the "done" state before the expensive YIN loop finishes.
 */
export async function uploadAndInsert(
  phrase: PhraseWithSong,
  uri: string,
): Promise<UploadResult> {
  const supabase = requireSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  const response = await fetch(uri);
  const blob = await response.blob();

  // Use the blob's actual MIME type (recorder picked the best the browser
  // supports — webm/opus on Chromium, mp4/aac on iOS Safari, etc).
  const mime = blob.type || (Platform.OS === 'web' ? 'audio/webm' : 'audio/m4a');
  const ext = mime.includes('mp4')
    ? 'm4a'
    : mime.includes('ogg')
      ? 'ogg'
      : mime.includes('webm')
        ? 'webm'
        : Platform.OS === 'web'
          ? 'webm'
          : 'm4a';
  const filename = `${Date.now()}.${ext}`;
  const path = `${user.id}/${filename}`;

  const { error: uploadErr } = await supabase.storage
    .from('attempts')
    .upload(path, blob, { contentType: mime, upsert: false });
  if (uploadErr) throw new Error(`upload: ${uploadErr.message}`);

  const { data: row, error: insertErr } = await supabase
    .from('attempts')
    .insert({ user_id: user.id, phrase_id: phrase.id, audio_path: path })
    .select('id')
    .single();
  if (insertErr) throw new Error(`insert: ${insertErr.message}`);

  return { attemptId: row.id as string, audioPath: path, audioUri: uri };
}

/**
 * Run client-side pitch analysis and persist to the attempt row. Called in
 * the background after the user has already transitioned to the done state.
 * Returns null on failure (analysis is best-effort).
 */
export async function runAnalysisAndSave(
  attemptId: string,
  notes: MidiNote[],
  audioUri: string,
): Promise<PitchAnalysis | null> {
  try {
    const analysis = await analyzeAttempt(audioUri, notes);
    await requireSupabase()
      .from('attempts')
      .update({ pitch_analysis: analysis })
      .eq('id', attemptId);
    return analysis;
  } catch (e) {
    console.warn('pitch analysis failed:', e);
    return null;
  }
}
