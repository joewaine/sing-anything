// Synced playback for a saved attempt. Decodes the user's recording into
// an AudioBuffer and schedules it on the same ctx.currentTime anchor as
// the backing+vocals loop, so all three sources (backing, lead vocal,
// your take) wrap together every iteration. Mirrors the done-view
// playback in SessionScreen but in standalone form for the takes list.

import { getAudioContext } from './audioService';
import { startPhraseLoop } from './phraseLoop';

export type TakePlaybackHandle = {
  stop: () => void;
  setBackingEnabled: (enabled: boolean) => void;
  setBackingVolume: (volume: number) => void;
  setVocalsEnabled: (enabled: boolean) => void;
  setVocalsVolume: (volume: number) => void;
  setTakeEnabled: (enabled: boolean) => void;
  setTakeVolume: (volume: number) => void;
  /** Seek to a position within the loop. All three sources jump in
   *  lockstep so backing/vocals/your take stay sample-aligned. */
  seek: (positionMs: number) => void;
  /** Read the current loop position in ms (wraps mod loopDurationSec). */
  getPositionMs: () => number;
  /** Total loop duration in ms — useful for sizing a slider track. */
  getDurationMs: () => number;
  /** Set the take's total shift in ms. Positive = pad start with
   *  silence (voice plays later). Negative = trim head (voice plays
   *  earlier). Rebuilds the aligned recording buffer and restarts
   *  the take source at the current loop position; backing keeps
   *  playing untouched. */
  setOffsetMs: (ms: number) => void;
};

export type TakePlaybackOptions = {
  recordingUrl: string;
  vocalsUrl: string;
  backingUrl: string | null;
  loopDurationSec: number;
  backingEnabled?: boolean;
  vocalsEnabled?: boolean;
  takeEnabled?: boolean;
  backingVolume?: number;
  vocalsVolume?: number;
  takeVolume?: number;
  songId?: string;
  phraseId?: string;
  /** Total shift applied to the take in ms. Caller computes — typical
   *  pattern: (analysis.detected_offset_ms ?? autoFallback) +
   *  user's manual nudge. Positive = pad start (voice later);
   *  negative = trim head (voice earlier). */
  offsetMs?: number;
};

const RAMP_SEC = 0.03;

export async function startTakePlayback(
  opts: TakePlaybackOptions,
): Promise<TakePlaybackHandle | null> {
  const ctx = getAudioContext();
  if (!ctx) return null;

  // Decode the user's recording. Done in parallel with phrase buffers
  // (which startPhraseLoop will cache or fetch as needed).
  let recordingBuffer: AudioBuffer | null = null;
  try {
    const response = await fetch(opts.recordingUrl);
    const arrayBuffer = await response.arrayBuffer();
    recordingBuffer = await ctx.decodeAudioData(arrayBuffer);
  } catch (e) {
    console.warn('[takePlayback] recording decode failed:', e);
  }

  // Common future timestamp — gives startPhraseLoop's internal awaits +
  // the source.start scheduling enough headroom.
  const commonStartAt = ctx.currentTime + 0.1;

  const phraseHandle = await startPhraseLoop({
    backingUrl: opts.backingUrl,
    vocalsUrl: opts.vocalsUrl,
    loopDurationSec: opts.loopDurationSec,
    backingCacheKey:
      opts.songId && opts.phraseId
        ? `${opts.songId}:${opts.phraseId}:backing`
        : undefined,
    vocalsCacheKey:
      opts.songId && opts.phraseId
        ? `${opts.songId}:${opts.phraseId}:vocals`
        : undefined,
    backingEnabled: opts.backingEnabled ?? true,
    backingVolume: opts.backingVolume ?? 0.7,
    vocalsEnabled: opts.vocalsEnabled ?? true,
    vocalsVolume: opts.vocalsVolume ?? 0.85,
    startAt: commonStartAt,
  });
  if (!phraseHandle) return null;

  // Pad/trim recording to loop length AND shift content by the total
  // offset the caller asked for. The shift is applied bidirectionally:
  //   shiftSec > 0 → aligned[shift..end] = recording[0..end-shift];
  //                  aligned[0..shift] = silence (voice plays later).
  //   shiftSec < 0 → aligned[0..end] = recording[|shift|..|shift|+end];
  //                  trim the head (voice plays earlier).
  //
  // shiftSec defaults to 0.05 + ctx.outputLatency only when the caller
  // didn't supply offsetMs. With analysis-driven detection the caller
  // computes the total directly and passes it.
  const autoFallbackSec = 0.05 + Math.max(0, ctx.outputLatency ?? 0);
  let currentOffsetMs =
    opts.offsetMs !== undefined && opts.offsetMs !== null
      ? opts.offsetMs
      : autoFallbackSec * 1000;

  const buildAligned = (offsetMs: number): AudioBuffer | null => {
    if (!recordingBuffer) return null;
    const targetLength = Math.max(
      1,
      Math.round(opts.loopDurationSec * recordingBuffer.sampleRate),
    );
    const shiftSamples = Math.round(
      (offsetMs / 1000) * recordingBuffer.sampleRate,
    );
    const aligned = ctx.createBuffer(
      recordingBuffer.numberOfChannels,
      targetLength,
      recordingBuffer.sampleRate,
    );
    for (let ch = 0; ch < recordingBuffer.numberOfChannels; ch++) {
      const src = recordingBuffer.getChannelData(ch);
      const dst = aligned.getChannelData(ch);
      if (shiftSamples >= 0) {
        const copyLen = Math.min(src.length, targetLength - shiftSamples);
        if (copyLen > 0) {
          dst.set(src.subarray(0, copyLen), shiftSamples);
        }
      } else {
        const srcStart = Math.min(src.length, -shiftSamples);
        const copyLen = Math.min(src.length - srcStart, targetLength);
        if (copyLen > 0) {
          dst.set(src.subarray(srcStart, srcStart + copyLen), 0);
        }
      }
    }
    return aligned;
  };

  let alignedRecording = buildAligned(currentOffsetMs);

  // Take's gain lives outside the source — survives seek so toggle
  // state doesn't reset when the user drags the scrubber.
  let takeGain: GainNode | null = null;
  let currentTakeVolume = Math.max(0, Math.min(1, opts.takeVolume ?? 1.0));
  let currentTakeEnabled = opts.takeEnabled !== false;
  if (alignedRecording) {
    takeGain = ctx.createGain();
    takeGain.gain.value = currentTakeEnabled ? currentTakeVolume : 0;
    takeGain.connect(ctx.destination);
  }

  let takeSource: AudioBufferSourceNode | null = null;
  const startTakeSource = (clockTime: number, offsetSec: number) => {
    if (!alignedRecording || !takeGain) return;
    if (takeSource) {
      try {
        takeSource.stop();
      } catch {
        // already stopped
      }
    }
    const s = ctx.createBufferSource();
    s.buffer = alignedRecording;
    s.loop = true;
    s.connect(takeGain);
    s.start(clockTime, offsetSec);
    takeSource = s;
  };
  startTakeSource(commonStartAt, 0);

  let stopped = false;

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
      phraseHandle.stop();
      if (takeSource) {
        try {
          takeSource.stop();
        } catch {
          // already stopped
        }
      }
    },
    setBackingEnabled: (b) => phraseHandle.setBackingEnabled(b),
    setBackingVolume: (v) => phraseHandle.setBackingVolume(v),
    setVocalsEnabled: (b) => phraseHandle.setVocalsEnabled(b),
    setVocalsVolume: (v) => phraseHandle.setVocalsVolume(v),
    setTakeEnabled: (b) => {
      currentTakeEnabled = b;
      if (takeGain) ramp(takeGain, b ? currentTakeVolume : 0);
    },
    setTakeVolume: (v) => {
      currentTakeVolume = Math.max(0, Math.min(1, v));
      if (takeGain && currentTakeEnabled) ramp(takeGain, currentTakeVolume);
    },
    seek(positionMs) {
      if (stopped) return;
      // Phrase loop seeks first; it returns the AudioContext anchor it
      // chose. We schedule the take source at the same instant so all
      // three sources land sample-aligned at the new position.
      const newAnchor = phraseHandle.seek(positionMs);
      const positionSec = Math.max(
        0,
        Math.min(opts.loopDurationSec, positionMs / 1000),
      );
      startTakeSource(newAnchor, positionSec);
    },
    getPositionMs: () => phraseHandle.getPositionMs(),
    getDurationMs: () => opts.loopDurationSec * 1000,
    setOffsetMs(ms) {
      if (stopped || !recordingBuffer) return;
      if (ms === currentOffsetMs) return;
      currentOffsetMs = ms;
      // Rebuild the aligned buffer with the new offset and restart
      // the take source at the current loop position. Backing keeps
      // playing — we re-anchor only the take.
      alignedRecording = buildAligned(ms);
      const positionMs = phraseHandle.getPositionMs();
      const positionSec = Math.max(
        0,
        Math.min(opts.loopDurationSec, positionMs / 1000),
      );
      startTakeSource(ctx.currentTime + 0.02, positionSec);
    },
  };
}
