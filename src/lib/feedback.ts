import { requireSupabase } from './supabase';

export type FeedbackResult = {
  feedback: string;
  try_next: string;
};

export async function requestFeedback(attemptId: string): Promise<FeedbackResult> {
  const { data, error } = await requireSupabase().functions.invoke<FeedbackResult>('feedback', {
    body: { attempt_id: attemptId },
  });
  if (error) throw new Error(`feedback: ${error.message}`);
  if (!data || typeof data.feedback !== 'string') {
    throw new Error('feedback: empty response');
  }
  return data;
}
