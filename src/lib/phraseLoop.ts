// Continuous phrase loop: backing + optional reference vocals played as a
// single, sample-accurate loop on the shared AudioContext. Replaces the
// previous Listen → count-in → backing-once flow with a single audio
// stream that plays from screen-arrival until the user navigates away.
//
// Why: the old flow had three audible seams (vocals-end silence, click
// scheduling pop, backing first-frame). Looping a single backing+vocals
// pair removes them all. Recording arms on a Record tap and starts at
// the next loop boundary so the take always anchors at clip t=0.

import { getAudioContext, getDecodedBuffer } from './audioService';

export type PhraseLoopHandle = {
  stop: () => void;
  setBackingEnabled: (enabled: boolean) => void;
  setBackingVolume: (volume: number) => void;
  setVocalsEnabled: (enabled: boolean) => void;
  /** Schedule a callback at the start of the next loop iteration.
   *  Returns a cancel fn. Used to arm recording at a clean t=0 anchor. */
  onNextLoopStart: (cb: () => void) => () => void;
  /** Ms until the next loop boundary fires (0 if it's about to). */
  getMsUntilNextLoop: () => number;
  /** Current position within the loop in ms (wraps mod loopDuration). */
  getPositionMs: () => number;
};

export type PhraseLoopOptions = {
  backingUrl: string | null;
  vocalsUrl: string | null;
  loopDurationSec: number;
  backingCacheKey?: string;
  vocalsCacheKey?: string;
  backingEnabled?: boolean;
  backingVolume?: number;
  vocalsEnabled?: boolean;
  vocalsVolume?: number;
  onPositionMs?: (ms: number) => void;
};

const RAMP_SEC = 0.03;

export async function startPhraseLoop(
  opts: PhraseLoopOptions,
): Promise<PhraseLoopHandle | null> {
  const ctx = getAudioContext();
  if (!ctx) return null;

  const [backing, vocals] = await Promise.all([
    opts.backingUrl
      ? getDecodedBuffer(opts.backingUrl, opts.backingCacheKey).catch((e) => {
          console.warn('backing load failed:', e);
          return null;
        })
      : Promise.resolve(null),
    opts.vocalsUrl
      ? getDecodedBuffer(opts.vocalsUrl, opts.vocalsCacheKey).catch((e) => {
          console.warn('vocals load failed:', e);
          return null;
        })
      : Promise.resolve(null),
  ]);

  // Small offset so source.start(...) is in the future — required by the
  // Web Audio spec on some browsers, and gives the next-loop scheduler a
  // stable anchor to count from.
  const startAt = ctx.currentTime + 0.05;
  const loopDur = Math.max(0.5, opts.loopDurationSec);

  let backingVolume = opts.backingVolume ?? 0.7;
  let backingEnabled = opts.backingEnabled ?? true;
  let vocalsEnabled = opts.vocalsEnabled ?? true;
  const vocalsVolume = opts.vocalsVolume ?? 0.85;

  let backingSource: AudioBufferSourceNode | null = null;
  let backingGain: GainNode | null = null;
  if (backing) {
    backingSource = ctx.createBufferSource();
    backingSource.buffer = backing;
    backingSource.loop = true;
    backingGain = ctx.createGain();
    backingGain.gain.value = backingEnabled ? backingVolume : 0;
    backingSource.connect(backingGain).connect(ctx.destination);
    backingSource.start(startAt);
  }

  let vocalsSource: AudioBufferSourceNode | null = null;
  let vocalsGain: GainNode | null = null;
  if (vocals) {
    vocalsSource = ctx.createBufferSource();
    vocalsSource.buffer = vocals;
    vocalsSource.loop = true;
    vocalsGain = ctx.createGain();
    vocalsGain.gain.value = vocalsEnabled ? vocalsVolume : 0;
    vocalsSource.connect(vocalsGain).connect(ctx.destination);
    vocalsSource.start(startAt);
  }

  const armedTimers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  let rafId: number | null = null;

  const tick = () => {
    if (stopped) return;
    const elapsed = ctx.currentTime - startAt;
    const ms = (((elapsed % loopDur) + loopDur) % loopDur) * 1000;
    opts.onPositionMs?.(ms);
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  const ramp = (gain: GainNode, target: number) => {
    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(target, t + RAMP_SEC);
  };

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      armedTimers.forEach(clearTimeout);
      armedTimers.clear();
      try { backingSource?.stop(); } catch { /* already stopped */ }
      try { vocalsSource?.stop(); } catch { /* already stopped */ }
    },
    setBackingEnabled(enabled) {
      backingEnabled = enabled;
      if (backingGain) ramp(backingGain, enabled ? backingVolume : 0);
    },
    setBackingVolume(volume) {
      backingVolume = Math.max(0, Math.min(1, volume));
      if (backingGain && backingEnabled) ramp(backingGain, backingVolume);
    },
    setVocalsEnabled(enabled) {
      vocalsEnabled = enabled;
      if (vocalsGain) ramp(vocalsGain, enabled ? vocalsVolume : 0);
    },
    onNextLoopStart(cb) {
      const elapsed = ctx.currentTime - startAt;
      const completedLoops = Math.max(0, Math.floor(elapsed / loopDur));
      const nextLoopAt = startAt + (completedLoops + 1) * loopDur;
      const delayMs = Math.max(0, (nextLoopAt - ctx.currentTime) * 1000);
      let cancelled = false;
      const timer = setTimeout(() => {
        armedTimers.delete(timer);
        if (!cancelled && !stopped) cb();
      }, delayMs);
      armedTimers.add(timer);
      return () => {
        cancelled = true;
        clearTimeout(timer);
        armedTimers.delete(timer);
      };
    },
    getMsUntilNextLoop() {
      const elapsed = ctx.currentTime - startAt;
      const completedLoops = Math.max(0, Math.floor(elapsed / loopDur));
      const nextLoopAt = startAt + (completedLoops + 1) * loopDur;
      return Math.max(0, (nextLoopAt - ctx.currentTime) * 1000);
    },
    getPositionMs() {
      const elapsed = ctx.currentTime - startAt;
      return (((elapsed % loopDur) + loopDur) % loopDur) * 1000;
    },
  };
}
