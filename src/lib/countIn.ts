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
  /** Optional reference vocals to play in sync with the backing track.
   *  When provided, the gain node is exposed via VocalsHandle so the UI
   *  can mute/unmute mid-take without re-scheduling. */
  vocalsUrl?: string | null;
  vocalsEnabled?: boolean;
  vocalsVolume?: number;
  /** Stable cache key for the buffer cache. Pass a value derived from
   *  `(song_id, phrase_id, stem)` so re-signed signed URLs still hit the
   *  same decoded buffer. */
  backingCacheKey?: string;
  vocalsCacheKey?: string;
  onBeat?: (beatNumber: number) => void;
  onBackingStart?: () => void;
  onPositionMs?: (ms: number) => void;
  onBackingEnd?: () => void;
};

export type CountInHandleWithVocals = CountInHandle & {
  setVocalsEnabled: (enabled: boolean) => void;
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
): Promise<CountInHandleWithVocals> {
  const {
    bpm,
    beats = 4,
    backingUrl,
    backingVolume = 0.55,
    vocalsUrl = null,
    vocalsEnabled = true,
    vocalsVolume = 0.85,
    backingCacheKey,
    vocalsCacheKey,
    onBeat,
    onBackingStart,
    onPositionMs,
    onBackingEnd,
  } = opts;

  const ctx = getAudioContext();
  if (!ctx) {
    return { stop: () => {}, setVocalsEnabled: () => {} };
  }

  // Preload buffers in parallel (cache-hit if already warmed during Listen).
  const [backing, vocals] = await Promise.all([
    backingUrl
      ? getDecodedBuffer(backingUrl, backingCacheKey).catch((e) => {
          console.warn('backing load failed:', e);
          return null;
        })
      : Promise.resolve(null),
    vocalsUrl
      ? getDecodedBuffer(vocalsUrl, vocalsCacheKey).catch((e) => {
          console.warn('vocals load failed:', e);
          return null;
        })
      : Promise.resolve(null),
  ]);

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

  // Vocals share the same `backingAt` clock so they stay locked to the
  // backing. Volume is controlled by `vocalsGain`, which the caller can
  // flip via the returned setVocalsEnabled() — no resampling, no re-decode.
  let vocalsSource: AudioBufferSourceNode | null = null;
  let vocalsGain: GainNode | null = null;
  if (vocals) {
    vocalsSource = ctx.createBufferSource();
    vocalsSource.buffer = vocals;
    vocalsGain = ctx.createGain();
    vocalsGain.gain.value = vocalsEnabled ? vocalsVolume : 0;
    vocalsSource.connect(vocalsGain).connect(ctx.destination);
    vocalsSource.start(backingAt);
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
      if (vocalsSource) {
        try { vocalsSource.stop(); } catch { /* already stopped */ }
      }
      // IMPORTANT: do NOT close the shared AudioContext here.
    },
    setVocalsEnabled: (enabled: boolean) => {
      if (!vocalsGain || !ctx) return;
      // Tiny ramp avoids a click on instant gain changes.
      const target = enabled ? vocalsVolume : 0;
      const t = ctx.currentTime;
      vocalsGain.gain.cancelScheduledValues(t);
      vocalsGain.gain.setValueAtTime(vocalsGain.gain.value, t);
      vocalsGain.gain.linearRampToValueAtTime(target, t + 0.03);
    },
  };
}
