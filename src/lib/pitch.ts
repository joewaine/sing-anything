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

/**
 * Decode an audio blob URL and run a monophonic pitch tracker across it.
 * Yields to the event loop periodically so the UI stays responsive while the
 * YIN loop runs. Reuses the shared AudioContext so we don't hit Safari's
 * per-page context cap on repeated attempts.
 */
export async function extractPitchCurve(audioUri: string): Promise<PitchSample[]> {
  const ctx = getAudioContext();
  if (!ctx) return [];

  const res = await fetch(audioUri);
  const arrayBuffer = await res.arrayBuffer();
  // decodeAudioData will consume (detach) the buffer — pass it directly instead
  // of allocating a second copy.
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

  const sampleRate = audioBuffer.sampleRate;
  const samples = audioBuffer.getChannelData(0);
  const hopSamples = Math.max(1, Math.floor((HOP_MS / 1000) * sampleRate));
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
    const centsOff = (actualMidi - note.pitch_midi) * 100;
    const onPitchCount = inWindow.filter(
      (s) => Math.abs((s.midi - note.pitch_midi) * 100) < HIT_TOLERANCE_CENTS,
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
  };
}

export async function analyzeAttempt(
  audioUri: string,
  notes: MidiNote[],
): Promise<PitchAnalysis> {
  const curve = await extractPitchCurve(audioUri);
  return compareToReference(curve, notes);
}
