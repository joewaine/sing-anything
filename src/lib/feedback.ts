import { requireSupabase } from './supabase';
import type { PitchAnalysis } from './pitch';
import type { PhraseWithSong } from './phrases';

export type FeedbackResult = {
  feedback: string;
  try_next: string;
};

export type FeedbackInlinePayload = {
  pitch_analysis: PitchAnalysis;
  phrase: {
    lyric_text: string | null;
    song: { name: string; artist: string | null };
  };
};

/**
 * Ask the edge function for feedback on an attempt. Pass the inline
 * payload (pitch_analysis + phrase metadata) when you have it locally —
 * the edge function will use it directly and skip the DB read round trip,
 * saving 150-500ms on the take's critical path. Falls back to the legacy
 * { attempt_id } shape on the edge if the payload is omitted.
 */
export async function requestFeedback(
  attemptId: string,
  inline?: FeedbackInlinePayload,
): Promise<FeedbackResult> {
  const body: Record<string, unknown> = { attempt_id: attemptId };
  if (inline) {
    body.pitch_analysis = inline.pitch_analysis;
    body.phrase = inline.phrase;
  }
  const { data, error } = await requireSupabase().functions.invoke<FeedbackResult>('feedback', {
    body,
  });
  if (error) throw new Error(`feedback: ${error.message}`);
  if (!data || typeof data.feedback !== 'string') {
    throw new Error('feedback: empty response');
  }
  return data;
}

/** Helper to construct the inline payload from a hydrated PhraseWithSong. */
export function feedbackInlineFor(
  phrase: PhraseWithSong,
  pitch_analysis: PitchAnalysis,
): FeedbackInlinePayload {
  return {
    pitch_analysis,
    phrase: {
      lyric_text: phrase.lyric_text,
      song: { name: phrase.song.name, artist: phrase.song.artist },
    },
  };
}
