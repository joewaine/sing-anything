import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { makeActiveNoteCursor } from '../lib/activeNoteCursor';
import type { MidiNote } from '../types';
import {
  BORDER_1BIT,
  COLORS,
  FONTS,
  GRID_BG,
  NOTE_GRADIENTS,
  SHADOW_1BIT,
} from '../theme';

type Props = {
  notes: MidiNote[];
  /**
   * Ref to the current playback position in ms. We read this from rAF inside
   * the ribbon and mutate DOM transforms imperatively so we don't force React
   * to re-render the session on every frame. Using a ref (not a prop number)
   * is what makes the motion smooth.
   */
  currentMsRef: RefObject<number>;
  durationMs: number;
  active?: boolean;
};

const HEIGHT = 130;
const PAD_TOP = 12;
const PAD_BOTTOM = 26;
// Note pill height is now derived per-render from the visible semitone
// step (see geometry useMemo) so a 1-semitone pitch difference looks
// exactly one pill-height tall on screen — making the piano roll's
// vertical spacing meaningful rather than decorative.
const MIN_NOTE_HEIGHT = 6;
const MAX_NOTE_HEIGHT = 16;

const MARQUEE_THRESHOLD_MS = 10_000;
const PX_PER_SEC = 80;
const PLAYHEAD_FRACTION = 0.33;
const PLAYHEAD_BAND_WIDTH = 56;

type NoteGeom = {
  x: number;
  w: number;
  y: number;
  h: number;
  lyric: string;
  gradient: string;
  startMs: number;
  endMs: number;
};

function NotesLayer({ geometry }: { geometry: NoteGeom[] }) {
  return (
    <>
      {geometry.map((g, i) => (
        <View
          key={i}
          pointerEvents="none"
          style={{ position: 'absolute', left: g.x, top: 0, width: g.w, height: HEIGHT }}
        >
          <View
            style={[
              styles.notePill,
              {
                width: g.w,
                top: g.y,
                height: g.h,
                backgroundImage: g.gradient,
              } as any,
            ]}
          />
          {g.lyric ? (
            <Text
              numberOfLines={1}
              style={[styles.lyric, { top: g.h + 4, left: -20, width: g.w + 40 }]}
            >
              {g.lyric}
            </Text>
          ) : null}
        </View>
      ))}
    </>
  );
}

// Real React.memo (the prior version was a wrapper function with no
// memoization — geometry is referentially stable thanks to useMemo, so
// the actual memo skip-rerender behavior matters at 60fps).
const MemoNotesLayer = memo(NotesLayer);

export default function PitchRibbon({
  notes,
  currentMsRef,
  durationMs,
  active = true,
}: Props) {
  const [containerWidth, setContainerWidth] = useState(0);
  const [activeIdx, setActiveIdx] = useState(-1);
  const activeIdxRef = useRef(-1);

  const scrollerRef = useRef<View>(null);
  const cursorRef = useRef<View>(null);

  const useMarquee = durationMs > MARQUEE_THRESHOLD_MS;

  // One pass over notes computes both bounds. Replaces two
  // `Math.min/max(...notes.map(...))` invocations which spread-allocate
  // an entire array every recompute and trip the spread arity limit on
  // very long phrases.
  const { minPitch, pitchRange } = useMemo(() => {
    if (notes.length === 0) return { minPitch: 60, pitchRange: 12 };
    let mn = notes[0].pitch_midi;
    let mx = notes[0].pitch_midi;
    for (let i = 1; i < notes.length; i++) {
      const p = notes[i].pitch_midi;
      if (p < mn) mn = p;
      if (p > mx) mx = p;
    }
    return { minPitch: mn, pitchRange: Math.max(3, mx - mn + 2) };
  }, [notes]);

  const innerWidth = useMarquee
    ? (durationMs / 1000) * PX_PER_SEC
    : containerWidth;

  // Pixel-per-semitone for the current visible pitch range. Drives note
  // pill height + the semitone grid lines so vertical distance on screen
  // = real pitch distance.
  const drawHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const semitoneStep = drawHeight / pitchRange;
  const noteHeight = Math.min(
    MAX_NOTE_HEIGHT,
    Math.max(MIN_NOTE_HEIGHT, semitoneStep),
  );

  const geometry = useMemo<NoteGeom[]>(() => {
    if (innerWidth === 0 || durationMs <= 0) return [];
    return notes.map((n, i) => {
      const x = Math.max(0, Math.min(innerWidth, (n.start_ms / durationMs) * innerWidth));
      const end = Math.max(0, Math.min(innerWidth, (n.end_ms / durationMs) * innerWidth));
      const normalized = (n.pitch_midi - minPitch + 1) / pitchRange;
      const y = PAD_TOP + (1 - normalized) * drawHeight - noteHeight / 2;
      return {
        x,
        w: Math.max(4, end - x),
        y,
        h: noteHeight,
        lyric: n.lyric ?? '',
        gradient: NOTE_GRADIENTS[i % NOTE_GRADIENTS.length],
        startMs: n.start_ms,
        endMs: n.end_ms,
      };
    });
  }, [notes, innerWidth, durationMs, minPitch, pitchRange, drawHeight, noteHeight]);

  // One faint horizontal line per semitone within the visible range.
  // Lets the eye verify "this note is two steps higher than that one"
  // — without the grid the y-axis is mostly decorative.
  const semitoneLines = useMemo(() => {
    if (drawHeight <= 0 || pitchRange <= 0) return [] as { y: number; bold: boolean }[];
    const lines: { y: number; bold: boolean }[] = [];
    for (let s = 0; s <= pitchRange; s++) {
      const midi = minPitch - 1 + s;
      const normalized = s / pitchRange;
      const y = PAD_TOP + (1 - normalized) * drawHeight;
      // Bold every 12 semitones (octave). Slight visual anchor for
      // larger phrases.
      lines.push({ y, bold: midi % 12 === 0 });
    }
    return lines;
  }, [minPitch, pitchRange, drawHeight]);

  const playheadX = containerWidth * PLAYHEAD_FRACTION;

  // Single rAF loop drives (a) the scroller/cursor transform imperatively
  // and (b) the active-note React state. (a) runs every frame with zero
  // React work; (b) only fires when the active index actually changes.
  // Active-note lookup uses a monotonic cursor (O(1) amortized) instead
  // of an O(N) linear scan — critical at 60fps × 30+ notes per phrase.
  useEffect(() => {
    if (!active) return;
    let rafId = 0;
    const cursor = makeActiveNoteCursor(notes);
    const tick = () => {
      const ms = currentMsRef.current ?? 0;

      if (useMarquee) {
        const tx = playheadX - (ms / 1000) * PX_PER_SEC;
        const el = scrollerRef.current as unknown as HTMLElement | null;
        if (el) el.style.transform = `translateX(${tx}px)`;
      } else if (containerWidth > 0 && durationMs > 0) {
        const x = (ms / durationMs) * containerWidth - 1;
        const el = cursorRef.current as unknown as HTMLElement | null;
        if (el) el.style.transform = `translateX(${x}px)`;
      }

      const idx = cursor(ms);
      if (idx !== activeIdxRef.current) {
        activeIdxRef.current = idx;
        setActiveIdx(idx);
      }

      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [active, useMarquee, playheadX, durationMs, containerWidth, notes, currentMsRef]);

  const onLayout = (e: LayoutChangeEvent) => setContainerWidth(e.nativeEvent.layout.width);

  return (
    <View style={styles.container} onLayout={onLayout}>
      <View style={styles.gridLayer} />
      {/* Per-semitone horizontal grid. The mid-line was decorative; this
          replaces it with one line per semitone in the visible range so
          the eye can read pitch distance directly off the canvas.
          Octaves are bolder. */}
      {semitoneLines.map((line, i) => (
        <View
          key={`semi-${i}`}
          pointerEvents="none"
          style={[styles.semitoneLine, line.bold && styles.semitoneLineOctave, { top: line.y }]}
        />
      ))}

      {useMarquee && active && containerWidth > 0 && (
        <View
          pointerEvents="none"
          style={[
            styles.playheadBand,
            {
              left: playheadX - PLAYHEAD_BAND_WIDTH / 2,
              width: PLAYHEAD_BAND_WIDTH,
            },
          ]}
        />
      )}

      {innerWidth > 0 && (
        <View
          ref={scrollerRef}
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: innerWidth,
            height: HEIGHT,
          }}
        >
          <MemoNotesLayer geometry={geometry} />
          {active && activeIdx >= 0 && <ActiveOverlay geom={geometry[activeIdx]} />}
        </View>
      )}

      {!useMarquee && active && containerWidth > 0 && (
        <View
          ref={cursorRef}
          pointerEvents="none"
          style={styles.cursorWrap}
        >
          <View style={styles.cursorArrowTop} />
          <View style={styles.cursorLine} />
          <View style={styles.cursorArrowBottom} />
        </View>
      )}
    </View>
  );
}

function ActiveOverlay({ geom }: { geom: NoteGeom }) {
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: geom.x, top: 0, width: geom.w, height: HEIGHT }}
    >
      <View
        style={[
          styles.notePill,
          styles.noteActive,
          {
            width: geom.w,
            top: geom.y,
            height: geom.h,
            backgroundImage: geom.gradient,
          } as any,
        ]}
      />
      {geom.lyric ? (
        <Text
          numberOfLines={1}
          style={[
            styles.lyric,
            styles.lyricActive,
            { top: geom.h + 4, left: -20, width: geom.w + 40 },
          ]}
        >
          {geom.lyric}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    width: '100%',
    height: HEIGHT,
    backgroundColor: COLORS.lightGrey,
    ...BORDER_1BIT,
    ...SHADOW_1BIT,
    overflow: 'hidden',
  },
  gridLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0.6,
    backgroundImage: GRID_BG,
  } as any,
  midLine: {
    position: 'absolute',
    top: '50%',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: COLORS.black,
    opacity: 0.25,
  },
  semitoneLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: COLORS.black,
    opacity: 0.08,
  },
  semitoneLineOctave: {
    opacity: 0.22,
  },
  playheadBand: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(255, 230, 0, 0.22)',
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.15)',
  },
  notePill: {
    position: 'absolute',
    // height is set per-instance from geometry (one semitone step) so
    // pitch distance reads correctly off the canvas. Default for any
    // legacy callers that pass no height; production paths override.
    height: MIN_NOTE_HEIGHT,
    borderRadius: 9999,
    ...BORDER_1BIT,
    ...SHADOW_1BIT,
  },
  noteActive: {
    boxShadow:
      'inset 0 2px 4px rgba(255,255,255,0.9), inset 0 -2px 3px rgba(0,0,0,0.3), 1px 1px 0 0 #000, 0 0 10px rgba(255,255,0,0.8)',
  } as any,
  lyric: {
    position: 'absolute',
    // top is set per-instance from geometry; default kept for legacy.
    top: MIN_NOTE_HEIGHT + 4,
    textAlign: 'center',
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.black,
    letterSpacing: 0,
  },
  lyricActive: {
    fontWeight: '700',
    textShadow:
      '1px 1px 0 #fff, -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff',
  } as any,
  cursorWrap: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 3,
    alignItems: 'center',
  },
  cursorLine: {
    flex: 1,
    width: 2,
    backgroundColor: COLORS.white,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: COLORS.black,
  },
  cursorArrowTop: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderLeftColor: 'transparent',
    borderRightWidth: 5,
    borderRightColor: 'transparent',
    borderTopWidth: 7,
    borderTopColor: COLORS.black,
  },
  cursorArrowBottom: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderLeftColor: 'transparent',
    borderRightWidth: 5,
    borderRightColor: 'transparent',
    borderBottomWidth: 7,
    borderBottomColor: COLORS.black,
  },
});
