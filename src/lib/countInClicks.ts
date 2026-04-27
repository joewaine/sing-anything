// 4-beat metronome click run, scheduled on the shared AudioContext.
// Used by the Record flow to give the singer a clean count-in before the
// looping phrase audio resumes from t=0 and recording begins.
//
// This is the click-only subset of the old countIn.ts — the
// backing-scheduling responsibilities moved to phraseLoop.ts.

import { getAudioContext } from './audioService';

export type CountInHandle = {
  stop: () => void;
};

export type CountInOptions = {
  bpm: number;
  beats?: number;
  onBeat?: (beatNumber: number) => void;
  onComplete?: () => void;
};

export function startCountIn({
  bpm,
  beats = 4,
  onBeat,
  onComplete,
}: CountInOptions): CountInHandle {
  const ctx = getAudioContext();
  if (!ctx) {
    if (onComplete) Promise.resolve().then(onComplete);
    return { stop: () => {} };
  }

  const beatSec = 60 / Math.max(20, bpm);
  const startAt = ctx.currentTime + 0.1;
  const oscillators: OscillatorNode[] = [];

  for (let i = 0; i < beats; i++) {
    const t = startAt + i * beatSec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = i === 0 ? 1200 : 800;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.07);
    oscillators.push(osc);
  }

  const timers: ReturnType<typeof setTimeout>[] = [];
  if (onBeat) {
    for (let i = 0; i < beats; i++) {
      const delay = (startAt + i * beatSec - ctx.currentTime) * 1000;
      timers.push(setTimeout(() => onBeat(i + 1), Math.max(0, delay)));
    }
  }
  if (onComplete) {
    const delay = (startAt + beats * beatSec - ctx.currentTime) * 1000;
    timers.push(setTimeout(onComplete, Math.max(0, delay)));
  }

  return {
    stop: () => {
      timers.forEach(clearTimeout);
      oscillators.forEach((o) => {
        try {
          o.stop();
        } catch {
          // already stopped
        }
      });
    },
  };
}
