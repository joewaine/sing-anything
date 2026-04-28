import { PitchDetector } from 'pitchy';
import type { MidiNote } from '../types';
import { getAudioContext } from './audioService';

const WINDOW_SIZE = 2048;
const HOP_MS = 10;
// 20% more forgiving than a pure quarter-tone hit — casual singing on a
// phone mic rarely holds 50¢ tight, and missing by 55-60¢ still sounds right.
const CLARITY_THRESHOLD = 0.80;
const HIT_TOLERANCE_CENTS = 60;
// Yield to the event loop every N hops so the main thread can paint + handle
// input while we run the YIN loop. 100 hops ~ 1s of audio at 10ms HOP_MS.
const HOPS_BEFORE_YIELD = 80;

export type PitchSample = {
  time_ms: number;
  freq_hz: number;
  midi: number;
  clarity: number;
};

export type NoteAnalysis = {
  idx: number;
  lyric: string;
  expected_midi: number;
  expected_note_name: string;
  actual_midi: number | null;
  cents_off: number | null;
  on_pitch_fraction: number;
  samples_in_window: number;
};

export type PitchAnalysis = {
  hit_rate: number;
  avg_abs_cents_off: number;
  median_clarity: number;
  notes: NoteAnalysis[];
  worst_note_idx: number | null;
  best_note_idx: number | null;
  overall_offset_cents: number;
  /** Auto-detected playback offset in ms. The shift that maximises
   *  voiced frames falling inside reference note windows — i.e. the
   *  offset that aligns the user's pitch contour with where notes are
   *  expected. Positive = pad start (delay voice); negative = trim
   *  head (advance voice). 0 if signal was too sparse to trust. */
  detected_offset_ms?: number;
};

function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

function midiToNoteName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const rounded = Math.round(midi);
  const octave = Math.floor(rounded / 12) - 1;
  return `${names[rounded % 12]}${octave}`;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const yieldToEventLoop = () => new Promise<void>((r) => setTimeout(r, 0));

// ─── Web Worker–based YIN ────────────────────────────────────────────────
//
// Web Workers have no AudioContext, so audio decoding has to happen on the
// main thread. The decoding itself is fast (~50-200ms) and yields to paint;
// the slow part is the YIN loop (2-5s for a 7s phrase) — which DOES need to
// be off-main. We main-thread-decode, then transfer the Float32Array PCM
// to a one-shot blob worker that returns the pitch curve.
//
// Inline blob-worker source (string template) lets this work across every
// bundler combo (Metro, Webpack, Vite) without needing a separate
// .worker.ts file or import.meta.url tricks.

const WORKER_SOURCE = `
self.onmessage = async (e) => {
  const { samplesBuffer, sampleRate, windowSize, hopSamples,
          clarityThreshold, hopsBeforeYield } = e.data;
  const samples = new Float32Array(samplesBuffer);

  // Inline pitchy ESM via dynamic import. Pitchy is small + ESM-native.
  const { PitchDetector } = await import('https://esm.sh/pitchy@4.1.0?bundle');

  const detector = PitchDetector.forFloat32Array(windowSize);
  const out = [];
  let sinceYield = 0;
  for (let i = 0; i + windowSize < samples.length; i += hopSamples) {
    const window = samples.subarray(i, i + windowSize);
    const [freq, clarity] = detector.findPitch(window, sampleRate);
    if (++sinceYield >= hopsBeforeYield) {
      sinceYield = 0;
      // Yield to the worker's own event loop so postMessage from main can
      // still reach us if the user navigates away.
      await new Promise((r) => setTimeout(r, 0));
    }
    if (freq <= 0 || clarity < clarityThreshold) continue;
    const midi = 69 + 12 * Math.log2(freq / 440);
    if (midi < 40 || midi > 90) continue;
    out.push({
      time_ms: Math.round((i / sampleRate) * 1000),
      freq_hz: freq,
      midi,
      clarity,
    });
  }
  self.postMessage({ ok: true, samples: out });
};
`;

let _workerUrl: string | null = null;

function workerSupported(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  );
}

function getWorkerUrl(): string {
  if (_workerUrl) return _workerUrl;
  const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
  _workerUrl = URL.createObjectURL(blob);
  return _workerUrl;
}

async function runYinInWorker(
  pcm: Float32Array,
  sampleRate: number,
  hopSamples: number,
): Promise<PitchSample[]> {
  return new Promise<PitchSample[]>((resolve, reject) => {
    const worker = new Worker(getWorkerUrl());
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('pitch-worker timed out'));
    }, 60_000);
    worker.onmessage = (e) => {
      clearTimeout(timeout);
      worker.terminate();
      if (e.data?.ok) resolve(e.data.samples as PitchSample[]);
      else reject(new Error(e.data?.error || 'pitch-worker failed'));
    };
    worker.onerror = (e) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(e.message || 'pitch-worker crashed'));
    };
    // Transfer the PCM buffer ownership rather than copying.
    worker.postMessage(
      {
        samplesBuffer: pcm.buffer,
        sampleRate,
        windowSize: WINDOW_SIZE,
        hopSamples,
        clarityThreshold: CLARITY_THRESHOLD,
        hopsBeforeYield: HOPS_BEFORE_YIELD,
      },
      [pcm.buffer],
    );
  });
}

async function runYinOnMainThread(
  samples: Float32Array,
  sampleRate: number,
  hopSamples: number,
): Promise<PitchSample[]> {
  const detector = PitchDetector.forFloat32Array(WINDOW_SIZE);
  const out: PitchSample[] = [];
  let sinceYield = 0;
  for (let i = 0; i + WINDOW_SIZE < samples.length; i += hopSamples) {
    const window = samples.subarray(i, i + WINDOW_SIZE);
    const [freq, clarity] = detector.findPitch(window, sampleRate);
    if (++sinceYield >= HOPS_BEFORE_YIELD) {
      sinceYield = 0;
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop();
    }
    if (freq <= 0 || clarity < CLARITY_THRESHOLD) continue;
    const midi = freqToMidi(freq);
    if (midi < 40 || midi > 90) continue;
    out.push({
      time_ms: Math.round((i / sampleRate) * 1000),
      freq_hz: freq,
      midi,
      clarity,
    });
  }
  return out;
}

/**
 * Decode an audio blob URL and run a monophonic pitch tracker across it.
 * decodeAudioData runs on the main thread (fast, paint-friendly); the YIN
 * loop runs in a one-shot blob worker so the 2-5s of analysis doesn't
 * freeze the post-record UI. Falls back to main-thread YIN with periodic
 * yields when Web Workers aren't available (older Safari, native RN).
 */
export async function extractPitchCurve(audioUri: string): Promise<PitchSample[]> {
  const ctx = getAudioContext();
  if (!ctx) return [];

  const res = await fetch(audioUri);
  const arrayBuffer = await res.arrayBuffer();
  // decodeAudioData will consume (detach) the buffer — pass it directly
  // instead of allocating a second copy.
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

  const sampleRate = audioBuffer.sampleRate;
  const channel = audioBuffer.getChannelData(0);
  const hopSamples = Math.max(1, Math.floor((HOP_MS / 1000) * sampleRate));

  if (workerSupported()) {
    try {
      // Copy into a fresh transferable buffer (channel is owned by
      // AudioBuffer; transferring its underlying ArrayBuffer would
      // detach the audio data).
      const pcm = new Float32Array(channel.length);
      pcm.set(channel);
      return await runYinInWorker(pcm, sampleRate, hopSamples);
    } catch (e) {
      console.warn('pitch worker failed, falling back to main thread:', e);
    }
  }
  return runYinOnMainThread(channel, sampleRate, hopSamples);
}

/** Fold a midi-difference into the same octave: returns the signed
 *  delta in semitones with magnitude <= 6. Lets us count someone
 *  singing the same note an octave up (or two octaves down) as on
 *  pitch — the WaveformCanvas already does this for its stroke colour;
 *  this brings the recorded-take analysis in line. */
function octaveFoldedSemitones(actual: number, expected: number): number {
  let d = actual - expected;
  while (d > 6) d -= 12;
  while (d < -6) d += 12;
  return d;
}

/**
 * Brute-force sync offset detection. Sweep candidate offsets in ±1s,
 * 10ms steps; for each, count how many voiced frames in the user's
 * pitch curve fall inside ANY reference note window when shifted by
 * that offset. The peak offset is what aligns the user's vocal with
 * the music — a closed-form fix for output-latency drift the browser
 * may under-report (Bluetooth headphones).
 *
 * Sign matches our buildAligned shift convention:
 *   positive → voice shifts later (pad head with silence),
 *   negative → voice shifts earlier (trim head).
 *
 * Returns 0 when the signal is too sparse, or when the peak isn't
 * meaningfully better than the no-shift baseline — better to leave
 * the recording untouched than to nudge it in the wrong direction.
 */
function detectBestSyncOffset(
  curve: PitchSample[],
  notes: MidiNote[],
): number {
  if (curve.length === 0 || notes.length === 0) return 0;
  const voiced = curve.filter((s) => s.clarity > 0.5);
  if (voiced.length < 8) return 0;

  const sorted = notes.slice().sort((a, b) => a.start_ms - b.start_ms);
  const isInNote = (t: number): boolean => {
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i];
      if (t < n.start_ms) return false;
      if (t <= n.end_ms) return true;
    }
    return false;
  };

  let bestOffset = 0;
  let bestCount = -1;
  for (let offsetMs = -1000; offsetMs <= 1000; offsetMs += 10) {
    let count = 0;
    for (const s of voiced) {
      if (isInNote(s.time_ms + offsetMs)) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestOffset = offsetMs;
    }
  }

  // Safety: peak must improve on the no-shift baseline by at least 5%
  // of voiced frames. If not, the recording is too noisy / off-pitch
  // for detection to be reliable — return 0 and let the user nudge
  // manually if they want.
  let baselineCount = 0;
  for (const s of voiced) {
    if (isInNote(s.time_ms)) baselineCount++;
  }
  if (bestCount < baselineCount + voiced.length * 0.05) {
    return 0;
  }
  return bestOffset;
}

export function compareToReference(
  curve: PitchSample[],
  notes: MidiNote[],
): PitchAnalysis {
  const analyses: NoteAnalysis[] = notes.map((note, idx) => {
    const inWindow = curve.filter(
      (s) => s.time_ms >= note.start_ms && s.time_ms <= note.end_ms,
    );
    if (inWindow.length === 0) {
      return {
        idx,
        lyric: note.lyric,
        expected_midi: note.pitch_midi,
        expected_note_name: midiToNoteName(note.pitch_midi),
        actual_midi: null,
        cents_off: null,
        on_pitch_fraction: 0,
        samples_in_window: 0,
      };
    }
    const actualMidi = median(inWindow.map((s) => s.midi));
    const centsOff =
      octaveFoldedSemitones(actualMidi, note.pitch_midi) * 100;
    const onPitchCount = inWindow.filter(
      (s) =>
        Math.abs(octaveFoldedSemitones(s.midi, note.pitch_midi) * 100) <
        HIT_TOLERANCE_CENTS,
    ).length;
    return {
      idx,
      lyric: note.lyric,
      expected_midi: note.pitch_midi,
      expected_note_name: midiToNoteName(note.pitch_midi),
      actual_midi: Number(actualMidi.toFixed(2)),
      cents_off: Number(centsOff.toFixed(1)),
      on_pitch_fraction: Number((onPitchCount / inWindow.length).toFixed(2)),
      samples_in_window: inWindow.length,
    };
  });

  const hit = analyses.filter(
    (a) => a.cents_off !== null && Math.abs(a.cents_off) < HIT_TOLERANCE_CENTS,
  );
  const scored = analyses.filter((a) => a.cents_off !== null);
  const absCents = scored.map((a) => Math.abs(a.cents_off!));
  const signedCents = scored.map((a) => a.cents_off!);

  let worst: NoteAnalysis | null = null;
  let best: NoteAnalysis | null = null;
  for (const a of scored) {
    if (worst === null || Math.abs(a.cents_off!) > Math.abs(worst.cents_off!)) worst = a;
    if (best === null || Math.abs(a.cents_off!) < Math.abs(best.cents_off!)) best = a;
  }

  return {
    hit_rate: Number((hit.length / Math.max(1, analyses.length)).toFixed(2)),
    avg_abs_cents_off: Number(
      (absCents.reduce((a, b) => a + b, 0) / Math.max(1, absCents.length)).toFixed(1),
    ),
    overall_offset_cents: Number(
      (signedCents.reduce((a, b) => a + b, 0) / Math.max(1, signedCents.length)).toFixed(1),
    ),
    median_clarity: Number(median(curve.map((s) => s.clarity)).toFixed(2)),
    notes: analyses,
    worst_note_idx: worst?.idx ?? null,
    best_note_idx: best?.idx ?? null,
    detected_offset_ms: detectBestSyncOffset(curve, notes),
  };
}

export async function analyzeAttempt(
  audioUri: string,
  notes: MidiNote[],
): Promise<PitchAnalysis> {
  const curve = await extractPitchCurve(audioUri);
  return compareToReference(curve, notes);
}
