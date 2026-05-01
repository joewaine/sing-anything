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

/** Fetch the latest non-terminal job for each of the current user's songs.
 *  Used by the Library to seed live progress on cold load — Realtime alone
 *  only delivers events that happen after subscribe, so we'd miss the
 *  state of any job that was already running when the user navigated in. */
export async function listActiveJobs(): Promise<Job[]> {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .not('stage', 'in', '(done,error)')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Job[];
}

/** Subscribes to UPDATE events on a specific job row. Returns an unsubscribe fn.
 *
 *  Race notes:
 *  - Realtime only delivers events that fire AFTER `subscribe()` returns. If
 *    the worker finishes before that, the terminal `done` UPDATE is missed.
 *    We do an immediate one-shot read on subscribe to catch that case.
 *  - Realtime can drop events under flaky network. The safety poll only
 *    fires when we haven't seen a Realtime event in REALTIME_QUIET_MS, so
 *    a healthy stream of events doesn't double up the API call rate.
 *  Both fallback paths short-circuit once the job hits a terminal stage.
 */
const REALTIME_QUIET_MS = 8000;
const SAFETY_POLL_INTERVAL_MS = 4000;

export function subscribeToJob(jobId: string, onUpdate: (job: Job) => void): () => void {
  const supabase = requireSupabase();
  let stopped = false;
  let lastStage: string | null = null;
  let lastRealtimeAt = Date.now();

  const fire = (job: Job, source: 'realtime' | 'poll' | 'initial') => {
    if (stopped) return;
    if (source === 'realtime') lastRealtimeAt = Date.now();
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
      (payload) => fire(payload.new as Job, 'realtime'),
    )
    .subscribe();

  // 1) Immediate read in case the job already moved past `queued` (or
  //    finished) before the subscribe handshake completed.
  void getJob(jobId).then((job) => fire(job, 'initial')).catch(() => {});

  // 2) Quiet-aware safety poll. Skips its DB read when Realtime has
  //    delivered an event in the last REALTIME_QUIET_MS — so a healthy
  //    job emits ~one Realtime event per stage instead of being doubled
  //    up by a 4s poll. Only fires its full read when Realtime has gone
  //    silent (likely network dropped a packet on the floor).
  const poll = setInterval(() => {
    if (stopped) return;
    if (Date.now() - lastRealtimeAt < REALTIME_QUIET_MS) return;
    void getJob(jobId).then((job) => {
      if (job.stage !== lastStage) fire(job, 'poll');
    }).catch(() => {});
  }, SAFETY_POLL_INTERVAL_MS);

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
