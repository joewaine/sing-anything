import type { MidiNote } from '../types';

/**
 * Active-note lookup as an O(1)-amortized monotonic cursor instead of an
 * O(N) per-frame scan. SessionScreen has 3-4 rAF loops (PitchRibbon,
 * LyricStrip, WaveformCanvas, countIn) that each independently asked
 * "which note is active at this ms?" via `notes.find(...)`. With 30+ notes
 * × 60Hz × 4 callbacks that's ~9,000 array iterations/sec on slow Android.
 *
 * Each call site allocates its own cursor via `makeActiveNoteCursor(notes)`
 * and asks `cursor(ms)` on every frame. Internal state is a single
 * integer that monotonically advances; backward seeks (e.g. user hits
 * Restart) are detected by `ms` decreasing and reset to 0.
 *
 * `notes` MUST be sorted by `start_ms` ascending — the worker pipeline
 * already produces them that way, and PitchRibbon's geometry assumes it
 * too, so this is a free invariant.
 */
export type ActiveNoteCursor = (ms: number) => number;

export function makeActiveNoteCursor(notes: MidiNote[]): ActiveNoteCursor {
  let cursor = 0;
  let lastMs = -1;
  return (ms: number): number => {
    // Backward seek (Restart, manual scrub) — restart from the top.
    // Cheap: notes is small (typically <40), and we only re-scan when ms
    // actually went backward, not on every frame.
    if (ms + 50 < lastMs) cursor = 0;
    lastMs = ms;
    for (let i = cursor; i < notes.length; i++) {
      const n = notes[i];
      if (ms < n.start_ms) return -1;       // not yet at any note
      if (ms < n.end_ms) {
        cursor = i;
        return i;
      }
      cursor = i + 1;                       // past this note's window
    }
    return -1;                              // past the last note
  };
}
