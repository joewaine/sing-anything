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
  /** Pre-roll (seconds) of backing-only audio before the phrase begins.
   *  We achieve this by starting the looping backing source from
   *  buffer position (duration - leadInSec) — so the loop's tail
   *  plays first, then wraps to position 0 and the phrase begins
   *  proper. Vocals start delayed by leadInSec so they enter aligned
   *  with backing[0]. After the first wrap both sources stay locked
   *  in sync. 0 = no lead-in (start clean). */
  leadInSec?: number;
  /** Override the AudioContext time at which the loop's sources start.
   *  Used by the done-view replay path to schedule the phrase loop
   *  and the user's recording at the same instant for sample-accurate
   *  sync. If omitted, defaults to ctx.currentTime + 0.05. */
  startAt?: number;
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
  // stable anchor to count from. Caller can override via opts.startAt
  // when it needs to sync the phrase loop with another source (e.g.
  // the user's recording during done-view replay).
  const startAt = opts.startAt ?? ctx.currentTime + 0.05;
  const loopDur = Math.max(0.5, opts.loopDurationSec);

  // Lead-in: we want some backing-only audio to play before the vocal
  // entry. Trick: start the backing source from buffer position
  // (duration - leadInSec) with loop=true. The Web Audio spec wraps
  // back to loopStart=0 when the source reaches the buffer end, so the
  // tail of the buffer plays first as a "lead-in", then the buffer
  // wraps and plays normally from t=0. Vocals are scheduled to start
  // at startAt + leadInSec so they enter exactly at backing[0]. After
  // the first wrap both sources stay locked, no per-wrap fixup needed.
  const leadInSec = Math.max(0, opts.leadInSec ?? 0);
  const backingDur = backing?.duration ?? loopDur;
  const backingOffset =
    leadInSec > 0 && backingDur > leadInSec ? backingDur - leadInSec : 0;
  // Audio anchor: when does buffer position 0 (start of phrase proper)
  // become audible? That's startAt + leadInSec. Used by the position
  // clock and onNextLoopStart so visuals + recording align with the
  // phrase, not with the lead-in.
  const phraseStartAt = startAt + leadInSec;

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
    backingSource.start(startAt, backingOffset);
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
    // Vocals start at the moment backing wraps to position 0.
    vocalsSource.start(phraseStartAt);
  }

  const armedTimers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  let rafId: number | null = null;

  // Output latency (in seconds) — the gap between when audio is
  // scheduled on the AudioContext and when it actually leaves the
  // speakers. On macOS Chrome this is typically 30–100 ms. The visual
  // cursor reads `ctx.currentTime` for "now", which is scheduled time;
  // without this subtraction the pitch ribbon and lyric strip would
  // lead the audio by exactly that much. Read once at startup — it's
  // effectively constant per device + driver state.
  const outputLatency =
    typeof ctx.outputLatency === 'number' && Number.isFinite(ctx.outputLatency)
      ? ctx.outputLatency
      : 0;

  const tick = () => {
    if (stopped) return;
    const audibleNow = ctx.currentTime - outputLatency;
    // During the lead-in (audibleNow < phraseStartAt) we report 0 so
    // the visual cursor sits at the start of the phrase. After the
    // lead-in completes the position counts up modulo loopDur.
    const elapsed = Math.max(0, audibleNow - phraseStartAt);
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
      // Loop boundaries are at phraseStartAt + N*loopDur (the lead-in
      // happens once at the very start; subsequent wraps are at the
      // phrase's t=0).
      const elapsed = ctx.currentTime - phraseStartAt;
      const completedLoops = Math.max(0, Math.floor(elapsed / loopDur));
      const nextLoopAt = phraseStartAt + (completedLoops + 1) * loopDur;
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
      const elapsed = ctx.currentTime - phraseStartAt;
      const completedLoops = Math.max(0, Math.floor(elapsed / loopDur));
      const nextLoopAt = phraseStartAt + (completedLoops + 1) * loopDur;
      return Math.max(0, (nextLoopAt - ctx.currentTime) * 1000);
    },
    getPositionMs() {
      const elapsed = Math.max(0, ctx.currentTime - phraseStartAt);
      return (((elapsed % loopDur) + loopDur) % loopDur) * 1000;
    },
  };
}
