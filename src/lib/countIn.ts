// Web Audio-driven count-in + backing playback.
// Schedules the metronome clicks and the backing track on the same AudioContext
// clock so the downbeat of the backing track lands exactly on beat N+1 after
// the count-in. Uses the shared AudioContext + decoded-buffer cache so the
// backing track does NOT re-fetch or re-decode on repeat attempts.

import { getAudioContext, getDecodedBuffer } from './audioService';

export type CountInHandle = {
  stop: () => void;
};

export type CountInOptions = {
  bpm: number;
  beats?: number;
  backingUrl: string | null;
  backingVolume?: number;
  onBeat?: (beatNumber: number) => void;
  onBackingStart?: () => void;
  onPositionMs?: (ms: number) => void;
  onBackingEnd?: () => void;
};

function scheduleClick(ctx: AudioContext, t: number, accent: boolean): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = accent ? 1200 : 800;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.18, t + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.07);
}

export async function startCountInAndBacking(
  opts: CountInOptions,
): Promise<CountInHandle> {
  const {
    bpm,
    beats = 4,
    backingUrl,
    backingVolume = 0.55,
    onBeat,
    onBackingStart,
    onPositionMs,
    onBackingEnd,
  } = opts;

  const ctx = getAudioContext();
  if (!ctx) return { stop: () => {} };

  // Preload the backing buffer (cache-hit if we already warmed during Listen).
  let backing: AudioBuffer | null = null;
  if (backingUrl) {
    try {
      backing = await getDecodedBuffer(backingUrl);
    } catch (e) {
      console.warn('backing load failed:', e);
    }
  }

  const beatSec = 60 / bpm;
  const startAt = ctx.currentTime + 0.1;
  const backingAt = startAt + beats * beatSec;

  for (let i = 0; i < beats; i++) {
    scheduleClick(ctx, startAt + i * beatSec, i === 0);
  }

  let source: AudioBufferSourceNode | null = null;
  if (backing) {
    source = ctx.createBufferSource();
    source.buffer = backing;
    const gain = ctx.createGain();
    gain.gain.value = backingVolume;
    source.connect(gain).connect(ctx.destination);
    source.start(backingAt);
    if (onBackingEnd) {
      source.onended = () => onBackingEnd();
    }
  }

  const timers: ReturnType<typeof setTimeout>[] = [];
  if (onBeat) {
    for (let i = 0; i < beats; i++) {
      const delay = (startAt + i * beatSec - ctx.currentTime) * 1000;
      timers.push(setTimeout(() => onBeat(i + 1), Math.max(0, delay)));
    }
  }
  if (onBackingStart) {
    const delay = (backingAt - ctx.currentTime) * 1000;
    timers.push(setTimeout(onBackingStart, Math.max(0, delay)));
  }

  let rafId: number | null = null;
  let stopped = false;
  const tickPosition = () => {
    if (stopped) return;
    const ms = (ctx.currentTime - backingAt) * 1000;
    onPositionMs?.(Math.max(0, ms));
    rafId = requestAnimationFrame(tickPosition);
  };
  if (onPositionMs) {
    const startPositionDelay = (backingAt - ctx.currentTime) * 1000;
    timers.push(
      setTimeout(() => {
        rafId = requestAnimationFrame(tickPosition);
      }, Math.max(0, startPositionDelay)),
    );
  }

  return {
    stop: () => {
      stopped = true;
      timers.forEach(clearTimeout);
      if (rafId) cancelAnimationFrame(rafId);
      if (source) {
        source.onended = null; // prevent double-fire via stop()
        try { source.stop(); } catch { /* already stopped */ }
      }
      // IMPORTANT: do NOT close the shared AudioContext here.
    },
  };
}
