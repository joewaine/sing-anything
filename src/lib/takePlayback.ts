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

  let takeSource: AudioBufferSourceNode | null = null;
  let takeGain: GainNode | null = null;
  if (recordingBuffer) {
    // Pad/trim to loopDurationSec so the recording wraps on the same
    // boundary as the phrase loop. Shorter takes get silent tail;
    // longer takes get trimmed (last loop's worth is dropped).
    const targetLength = Math.max(
      1,
      Math.round(opts.loopDurationSec * recordingBuffer.sampleRate),
    );
    let aligned: AudioBuffer = recordingBuffer;
    if (recordingBuffer.length !== targetLength) {
      aligned = ctx.createBuffer(
        recordingBuffer.numberOfChannels,
        targetLength,
        recordingBuffer.sampleRate,
      );
      for (let ch = 0; ch < recordingBuffer.numberOfChannels; ch++) {
        const src = recordingBuffer.getChannelData(ch);
        const dst = aligned.getChannelData(ch);
        const copyLen = Math.min(src.length, dst.length);
        dst.set(src.subarray(0, copyLen), 0);
      }
    }
    takeSource = ctx.createBufferSource();
    takeSource.buffer = aligned;
    takeSource.loop = true;
    takeGain = ctx.createGain();
    takeGain.gain.value = opts.takeEnabled !== false ? 1.0 : 0;
    takeSource.connect(takeGain).connect(ctx.destination);
    takeSource.start(commonStartAt);
  }

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
  };
}
