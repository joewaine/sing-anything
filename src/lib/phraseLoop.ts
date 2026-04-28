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
  setVocalsVolume: (volume: number) => void;
  /** Schedule a callback at the start of the next loop iteration.
   *  Returns a cancel fn. Used to arm recording at a clean t=0 anchor. */
  onNextLoopStart: (cb: () => void) => () => void;
  /** Ms until the next loop boundary fires (0 if it's about to). */
  getMsUntilNextLoop: () => number;
  /** Current position within the loop in ms (wraps mod loopDuration). */
  getPositionMs: () => number;
  /** Seek to a position within the loop. Stops the current backing +
   *  vocals sources and starts new ones at the corresponding buffer
   *  offset. Returns the AudioContext anchor time the new sources were
   *  scheduled at — callers (e.g. takePlayback) use this to schedule
   *  sibling sources (the user's recording) at the same clock instant. */
  seek: (positionMs: number) => number;
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
  let vocalsVolume = opts.vocalsVolume ?? 0.85;

  // Gain nodes live outside the source so seek() can recreate the
  // sources without touching the gain — toggle state survives a seek.
  let backingGain: GainNode | null = null;
  if (backing) {
    backingGain = ctx.createGain();
    backingGain.gain.value = backingEnabled ? backingVolume : 0;
    backingGain.connect(ctx.destination);
  }
  let vocalsGain: GainNode | null = null;
  if (vocals) {
    vocalsGain = ctx.createGain();
    vocalsGain.gain.value = vocalsEnabled ? vocalsVolume : 0;
    vocalsGain.connect(ctx.destination);
  }

  // Mutable phraseStartAt — seek() reanchors it so getPositionMs and
  // onNextLoopStart stay correct after a jump.
  let phraseAnchor = phraseStartAt;

  let backingSource: AudioBufferSourceNode | null = null;
  let vocalsSource: AudioBufferSourceNode | null = null;

  // Schedule a new backing+vocals source pair at clockTime, with the
  // backing buffer playing from `bufferOffset` and vocals from t=0.
  // bufferOffset is normally `backingDur - leadInSec` for the lead-in
  // start, or `position` for a seek.
  const startSources = (
    clockTime: number,
    bOffset: number,
    vOffset: number,
  ) => {
    if (backingSource) {
      try { backingSource.stop(); } catch { /* already stopped */ }
    }
    if (vocalsSource) {
      try { vocalsSource.stop(); } catch { /* already stopped */ }
    }
    if (backing && backingGain) {
      const s = ctx.createBufferSource();
      s.buffer = backing;
      s.loop = true;
      s.connect(backingGain);
      s.start(clockTime, bOffset);
      backingSource = s;
    }
    if (vocals && vocalsGain) {
      const s = ctx.createBufferSource();
      s.buffer = vocals;
      s.loop = true;
      s.connect(vocalsGain);
      s.start(clockTime, vOffset);
      vocalsSource = s;
    }
  };

  // Initial start. Two scheduled clock times in play: backing starts
  // at `startAt` (with offset = backingOffset to get the lead-in
  // tail), vocals start at `phraseStartAt` so they enter when backing
  // wraps to buffer t=0. When leadInSec=0 (the default since the
  // worker bakes the lead-in into the audio file), startAt ===
  // phraseStartAt and both fire together.
  if (backing && backingGain) {
    const s = ctx.createBufferSource();
    s.buffer = backing;
    s.loop = true;
    s.connect(backingGain);
    s.start(startAt, backingOffset);
    backingSource = s;
  }
  if (vocals && vocalsGain) {
    const s = ctx.createBufferSource();
    s.buffer = vocals;
    s.loop = true;
    s.connect(vocalsGain);
    s.start(phraseStartAt, 0);
    vocalsSource = s;
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
    // During the lead-in (audibleNow < phraseAnchor) we report 0 so
    // the visual cursor sits at the start of the phrase. After the
    // lead-in completes (or after a seek) the position counts up
    // modulo loopDur from phraseAnchor.
    const elapsed = Math.max(0, audibleNow - phraseAnchor);
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
    setVocalsVolume(volume) {
      vocalsVolume = Math.max(0, Math.min(1, volume));
      if (vocalsGain && vocalsEnabled) ramp(vocalsGain, vocalsVolume);
    },
    seek(positionMs) {
      const positionSec = Math.max(
        0,
        Math.min(loopDur, positionMs / 1000),
      );
      const newClock = ctx.currentTime + 0.02;
      // When seeking, both sources play from positionSec — no lead-in
      // (the lead-in is a one-time intro, not a per-seek behaviour).
      startSources(newClock, positionSec, positionSec);
      // Anchor adjust: at clockTime newClock, audible position should
      // be positionSec. We want elapsed = audibleNow - phraseAnchor =
      // positionSec at audibleNow = newClock - outputLatency, so
      // phraseAnchor = newClock - outputLatency - positionSec. For
      // simplicity we pretend audibleNow ≈ newClock (the few-ms gap
      // between scheduled and audible is irrelevant for the slider).
      phraseAnchor = newClock - positionSec;
      return newClock;
    },
    onNextLoopStart(cb) {
      // Loop boundaries are at phraseAnchor + N*loopDur. Lead-in
      // happens once before phraseAnchor; seek re-anchors it.
      const elapsed = ctx.currentTime - phraseAnchor;
      const completedLoops = Math.max(0, Math.floor(elapsed / loopDur));
      const nextLoopAt = phraseAnchor + (completedLoops + 1) * loopDur;
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
      const elapsed = ctx.currentTime - phraseAnchor;
      const completedLoops = Math.max(0, Math.floor(elapsed / loopDur));
      const nextLoopAt = phraseAnchor + (completedLoops + 1) * loopDur;
      return Math.max(0, (nextLoopAt - ctx.currentTime) * 1000);
    },
    getPositionMs() {
      const elapsed = Math.max(0, ctx.currentTime - phraseAnchor);
      return (((elapsed % loopDur) + loopDur) % loopDur) * 1000;
    },
  };
}
