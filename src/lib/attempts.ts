import { Platform } from 'react-native';
import { requireSupabase } from './supabase';
import { analyzeAttempt, type PitchAnalysis } from './pitch';
import type { MidiNote } from '../types';
import type { PhraseWithSong } from './phrases';

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
