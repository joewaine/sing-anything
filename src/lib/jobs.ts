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

/** Subscribes to UPDATE events on a specific job row. Returns an unsubscribe fn.
 *
 *  Race notes:
 *  - Realtime only delivers events that fire AFTER `subscribe()` returns. If
 *    the worker finishes before that, the terminal `done` UPDATE is missed.
 *    We do an immediate one-shot read on subscribe to catch that case.
 *  - Realtime can drop events under flaky network. We poll every 4s as a
 *    cheap safety net while the job is still in flight.
 *  Both fallback paths short-circuit once the job hits a terminal stage.
 */
export function subscribeToJob(jobId: string, onUpdate: (job: Job) => void): () => void {
  const supabase = requireSupabase();
  let stopped = false;
  let lastStage: string | null = null;

  const fire = (job: Job) => {
    if (stopped) return;
    lastStage = job.stage;
    onUpdate(job);
    if (job.stage === 'done' || job.stage === 'error') stop();
  };

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
      (payload) => fire(payload.new as Job),
    )
    .subscribe();

  // 1) Immediate read in case the job already moved past `queued` (or
  //    finished) before the subscribe handshake completed.
  void getJob(jobId).then((job) => fire(job)).catch(() => {});

  // 2) Slow safety poll. Realtime is the primary signal; this just rescues
  //    the user if a postgres_changes event dropped on the floor.
  const poll = setInterval(() => {
    if (stopped) return;
    void getJob(jobId).then((job) => {
      if (job.stage !== lastStage) fire(job);
    }).catch(() => {});
  }, 4000);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    void supabase.removeChannel(channel);
  }

  return stop;
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
