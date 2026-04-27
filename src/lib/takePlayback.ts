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
  setVocalsEnabled: (enabled: boolean) => void;
  setTakeEnabled: (enabled: boolean) => void;
  /** Seek to a position within the loop. All three sources jump in
   *  lockstep so backing/vocals/your take stay sample-aligned. */
  seek: (positionMs: number) => void;
  /** Read the current loop position in ms (wraps mod loopDurationSec). */
  getPositionMs: () => number;
  /** Total loop duration in ms — useful for sizing a slider track. */
  getDurationMs: () => number;
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
  songId?: string;
  phraseId?: string;
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
    startAt: commonStartAt,
  });
  if (!phraseHandle) return null;

  // Pad/trim recording to loop length once, store buffer in closure
  // for reuse on seek (we need to re-create the source each time).
  let alignedRecording: AudioBuffer | null = null;
  if (recordingBuffer) {
    const targetLength = Math.max(
      1,
      Math.round(opts.loopDurationSec * recordingBuffer.sampleRate),
    );
    if (recordingBuffer.length === targetLength) {
      alignedRecording = recordingBuffer;
    } else {
      alignedRecording = ctx.createBuffer(
        recordingBuffer.numberOfChannels,
        targetLength,
        recordingBuffer.sampleRate,
      );
      for (let ch = 0; ch < recordingBuffer.numberOfChannels; ch++) {
        const src = recordingBuffer.getChannelData(ch);
        const dst = alignedRecording.getChannelData(ch);
        const copyLen = Math.min(src.length, dst.length);
        dst.set(src.subarray(0, copyLen), 0);
      }
    }
  }

  // Take's gain lives outside the source — survives seek so toggle
  // state doesn't reset when the user drags the scrubber.
  let takeGain: GainNode | null = null;
  if (alignedRecording) {
    takeGain = ctx.createGain();
    takeGain.gain.value = opts.takeEnabled !== false ? 1.0 : 0;
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
    setVocalsEnabled: (b) => phraseHandle.setVocalsEnabled(b),
    setTakeEnabled: (b) => {
      if (takeGain) ramp(takeGain, b ? 1.0 : 0);
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
  };
}
