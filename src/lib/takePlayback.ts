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
  /** Adjust the user-take's sync offset in ms — layered on top of the
   *  auto-detected output latency. Positive = shift voice later
   *  (compensate for Bluetooth output lag that the browser
   *  under-reports). Rebuilds the aligned recording buffer and
   *  restarts the take source at the current loop position. */
  setExtraOffsetMs: (ms: number) => void;
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
  /** Initial extra sync offset in ms (user-adjustable nudge). */
  extraOffsetMs?: number;
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

  // Pad/trim recording to loop length AND shift content right by the
  // recording-time latency gap so playback syncs with the backing.
  // See full explanation below the buildAligned definition.
  const autoHeadOffsetSec = 0.05 + Math.max(0, ctx.outputLatency ?? 0);
  let currentExtraOffsetMs = opts.extraOffsetMs ?? 0;

  const buildAligned = (extraOffsetMs: number): AudioBuffer | null => {
    if (!recordingBuffer) return null;
    const targetLength = Math.max(
      1,
      Math.round(opts.loopDurationSec * recordingBuffer.sampleRate),
    );
    const totalOffsetSec = Math.max(0, autoHeadOffsetSec + extraOffsetMs / 1000);
    const headOffsetSamples = Math.max(
      0,
      Math.round(totalOffsetSec * recordingBuffer.sampleRate),
    );
    const aligned = ctx.createBuffer(
      recordingBuffer.numberOfChannels,
      targetLength,
      recordingBuffer.sampleRate,
    );
    for (let ch = 0; ch < recordingBuffer.numberOfChannels; ch++) {
      const src = recordingBuffer.getChannelData(ch);
      const dst = aligned.getChannelData(ch);
      const copyLen = Math.min(src.length, targetLength - headOffsetSamples);
      if (copyLen > 0) {
        dst.set(src.subarray(0, copyLen), headOffsetSamples);
      }
    }
    return aligned;
  };

  // During recording: recorder.start() fires at wall-clock R0 — mic
  // captures from there. Backing was scheduled at ctx.currentTime +
  // 0.05 and became audible at scheduled + outputLatency. So the first
  // audible backing sample reached the user's ear ~0.05 + outputLatency
  // seconds AFTER recording[0]. The user's voice in recording[t] is
  // responding to backing[t - autoHeadOffset]. Replay shifts recording
  // content right by that amount so they align.
  //
  // Bluetooth complication: outputLatency may under-report by 100–
  // 300ms on Bluetooth headphones (browser dependent). The user-
  // adjustable extraOffsetMs nudge lets the user dial in extra shift
  // until their voice sounds in pocket.
  let alignedRecording = buildAligned(currentExtraOffsetMs);

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
    setExtraOffsetMs(ms) {
      if (stopped || !recordingBuffer) return;
      if (ms === currentExtraOffsetMs) return;
      currentExtraOffsetMs = ms;
      // Rebuild the aligned buffer with the new offset and restart the
      // take source at the current loop position. Backing keeps
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
