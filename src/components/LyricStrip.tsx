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
// so the active line stays near the top. Lets long phrases / whole-
// song clips fit a fixed-height box without crowding the controls
// below.
const VISIBLE_LINES = 4;
const LINE_HEIGHT = 20;

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

  // Bias: keep the active line at row 1 of 4 visible (one line of past
  // context above, three of upcoming lyric below). When near the start
  // or end of the song, clamp so we never scroll past the content.
  const activeLineIdx =
    activeIdx === -1 ? 0 : lineByItemIdx.get(activeIdx) ?? 0;
  const maxStart = Math.max(0, lines.length - VISIBLE_LINES);
  const startLine = Math.max(0, Math.min(maxStart, activeLineIdx - 1));
  const translateY = -startLine * LINE_HEIGHT;
  const visibleHeight =
    Math.min(VISIBLE_LINES, lines.length) * LINE_HEIGHT;

  return (
    <View style={styles.strip}>
      <View style={[styles.box, { height: visibleHeight + 8 }]}>
        <View style={[styles.inner, { transform: [{ translateY }] }]}>
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
    alignItems: 'flex-start',
    width: '100%',
  },
  box: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    ...BORDER_1BIT,
    ...SHADOW_1BIT,
    backgroundColor: COLORS.white,
    overflow: 'hidden',
    minWidth: '50%',
  },
  inner: {
    // transform translateY scrolls the contained lines up as the
    // active line advances. CSS transition makes the scroll smooth on
    // web; native falls back to a hard jump (acceptable — the
    // boundary fires every ~6s).
    // @ts-expect-error — RN web ignores this on native
    transition: 'transform 0.25s ease-out',
  },
  line: {
    fontFamily: FONTS.monaco,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: LINE_HEIGHT,
    color: COLORS.black,
  },
  active: {
    backgroundColor: COLORS.black,
    color: COLORS.white,
  },
});
