import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { makeActiveNoteCursor } from '../lib/activeNoteCursor';
import type { MidiNote } from '../types';
import { BORDER_1BIT, COLORS, FONTS, SHADOW_1BIT } from '../theme';

type Props = {
  notes: MidiNote[];
  currentMsRef: RefObject<number>;
  fallbackText: string | null;
  active?: boolean;
};

// Minimum gap between consecutive notes (end of one to start of next)
// before we insert a line break. ~600ms is a comfortable breath; tight
// phrases stay on one line, while clearly-separated thoughts wrap.
const LINE_BREAK_GAP_MS = 600;
// Lyric box shows at most VISIBLE_LINES rows; the rest is clipped via
// overflow:hidden and a translateY transform that scrolls the viewport
// so the active line stays near the top. 3 lines = past + active +
// upcoming, with the active line biased to row 1 (middle) so the next
// line is always in view.
const VISIBLE_LINES = 3;
const LINE_HEIGHT = 22;

/**
 * Renders the phrase lyric as individual syllables; when `active`, runs its own
 * rAF loop that reads currentMsRef and flips an internal activeIdx so the
 * currently-sung syllable gets black-on-white emphasis. Independent from
 * PitchRibbon's loop — each component tracks its own boundary crossings.
 */
export default function LyricStrip({
  notes,
  currentMsRef,
  fallbackText,
  active = true,
}: Props) {
  const [activeIdx, setActiveIdx] = useState(-1);
  const activeIdxRef = useRef(-1);

  // Items: notes with non-empty lyric, with breakBefore flag for new
  // lines. Same logic as before — the line break is what we group on
  // to build the fixed-line viewport.
  const items = useMemo(() => {
    const filtered = notes
      .map((n, idx) => ({ note: n, idx }))
      .filter((x) => !!x.note.lyric);
    return filtered.map((x, i) => {
      const prev = i > 0 ? filtered[i - 1].note : null;
      const breakBefore =
        prev !== null && x.note.start_ms - prev.end_ms >= LINE_BREAK_GAP_MS;
      return { ...x, breakBefore };
    });
  }, [notes]);

  // Group items into lines so the viewport can translate by line index.
  const lines = useMemo(() => {
    const result: { items: typeof items }[] = [];
    let current: typeof items = [];
    for (const item of items) {
      if (item.breakBefore && current.length > 0) {
        result.push({ items: current });
        current = [];
      }
      current.push(item);
    }
    if (current.length > 0) result.push({ items: current });
    return result;
  }, [items]);

  // O(1) lookup from item.idx -> line index (for activeLine resolution).
  const lineByItemIdx = useMemo(() => {
    const map = new Map<number, number>();
    lines.forEach((line, lineIdx) => {
      line.items.forEach((x) => map.set(x.idx, lineIdx));
    });
    return map;
  }, [lines]);

  useEffect(() => {
    if (!active) {
      if (activeIdxRef.current !== -1) {
        activeIdxRef.current = -1;
        setActiveIdx(-1);
      }
      return;
    }
    let rafId = 0;
    const cursor = makeActiveNoteCursor(notes);
    const tick = () => {
      const ms = currentMsRef.current ?? 0;
      const idx = cursor(ms);
      if (idx !== activeIdxRef.current) {
        activeIdxRef.current = idx;
        setActiveIdx(idx);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [active, notes, currentMsRef]);

  if (items.length === 0) {
    return (
      <View style={styles.strip}>
        <View style={styles.box}>
          <Text style={styles.line}>{fallbackText || '—'}</Text>
        </View>
      </View>
    );
  }

  // Sticky active-line tracker. The cursor returns -1 between notes
  // (in gaps), which used to snap activeLineIdx back to 0 — and the
  // viewport jolted back to the top until the next note hit. We keep
  // the last-known line until a NEW note arrives, so scrolling only
  // ever advances forward.
  const [activeLineIdx, setActiveLineIdx] = useState(0);
  useEffect(() => {
    if (activeIdx < 0) return;
    const fresh = lineByItemIdx.get(activeIdx);
    if (fresh !== undefined && fresh !== activeLineIdx) {
      setActiveLineIdx(fresh);
    }
  }, [activeIdx, lineByItemIdx, activeLineIdx]);
  // Reset to the start when the lyric content changes (new phrase).
  useEffect(() => {
    setActiveLineIdx(0);
  }, [lines]);

  // Active stays at row 1 (middle) of the 3-line viewport whenever
  // possible — one past line, active, one upcoming. At the very start
  // (activeLineIdx 0) row 0 is shown with no past context; at the
  // very end the bottom of the lyric anchors the window.
  const maxStart = Math.max(0, lines.length - VISIBLE_LINES);
  const startLine = Math.max(0, Math.min(maxStart, activeLineIdx - 1));
  const translateY = -startLine * LINE_HEIGHT;
  const visibleHeight =
    Math.min(VISIBLE_LINES, lines.length) * LINE_HEIGHT;

  return (
    <View style={styles.strip}>
      <View style={[styles.box, { height: visibleHeight + 8 }]}>
        <View
          style={[
            styles.inner,
            // Inline transition so RN web doesn't strip it. translateY
            // updates step by 1 line at a time as activeLineIdx
            // advances; the CSS transition makes the scroll smooth
            // instead of jumping.
            {
              transform: [{ translateY }],
              transitionProperty: 'transform',
              transitionDuration: '0.4s',
              transitionTimingFunction: 'ease-out',
              willChange: 'transform',
              // RN web passes these through as inline DOM CSS;
              // native ignores them silently.
            } as Record<string, unknown>,
          ]}
        >
          {lines.map((line, lineIdx) => (
            <Text key={lineIdx} style={styles.line} numberOfLines={1}>
              {line.items.map((x, i) => {
                const isActive = x.idx === activeIdx;
                return (
                  <Text key={x.idx}>
                    {i > 0 ? ' ' : ''}
                    <Text style={isActive ? styles.active : undefined}>
                      {x.note.lyric}
                    </Text>
                  </Text>
                );
              })}
            </Text>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    paddingHorizontal: 16,
    paddingVertical: 4,
    alignItems: 'stretch',
    width: '100%',
  },
  box: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    ...BORDER_1BIT,
    ...SHADOW_1BIT,
    backgroundColor: COLORS.white,
    overflow: 'hidden',
    // Box fills the container width and clips long lyric lines via
    // overflow:hidden + numberOfLines={1} on each inner <Text>.
    // Without an explicit width the box previously expanded to fit
    // the longest line, sometimes pushing past the viewport on
    // small screens.
    width: '100%',
    maxWidth: '100%',
  },
  inner: {
    // transform translateY scrolls the contained lines up as the
    // active line advances. The actual transition props live inline
    // on the component so they survive RN StyleSheet's filter; this
    // entry exists only so we have a named style key for layout.
  },
  line: {
    fontFamily: FONTS.monaco,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: LINE_HEIGHT,
    color: COLORS.black,
    // Each line constrained to the box width so numberOfLines={1}
    // produces an ellipsis instead of expanding the box.
    width: '100%',
  },
  active: {
    backgroundColor: COLORS.black,
    color: COLORS.white,
  },
});
