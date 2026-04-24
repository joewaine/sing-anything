import { requireSupabase } from './supabase';
import type { Job } from '../types';

export async function getJob(id: string): Promise<Job> {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data as Job;
}

/** Subscribes to UPDATE events on a specific job row. Returns an unsubscribe fn. */
export function subscribeToJob(jobId: string, onUpdate: (job: Job) => void): () => void {
  const supabase = requireSupabase();
  const channel = supabase
    .channel(`job-${jobId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'jobs',
        filter: `id=eq.${jobId}`,
      },
      (payload) => onUpdate(payload.new as Job),
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

/** Poll a job every `intervalMs` until it's terminal or the abort signal fires. */
export async function pollJob(
  jobId: string,
  onUpdate: (job: Job) => void,
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<Job> {
  const interval = opts.intervalMs ?? 2000;
  while (true) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const job = await getJob(jobId);
    onUpdate(job);
    if (job.stage === 'done' || job.stage === 'error') return job;
    await new Promise((r) => setTimeout(r, interval));
  }
}
