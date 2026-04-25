import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { StyleSheet, Text, View } from 'react-native';
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

  // Pre-compute the renderable items once per note array — filters out notes
  // whose lyric is empty so the spacing matches Python's " ".join(...) output.
  // `breakBefore` flags items where the previous lyric ended at least
  // LINE_BREAK_GAP_MS earlier, signalling the start of a new line.
  const items = useMemo(() => {
    const filtered = notes
      .map((n, idx) => ({ note: n, idx }))
      .filter((x) => !!x.note.lyric);
    return filtered.map((x, i) => {
      const prev = i > 0 ? filtered[i - 1].note : null;
      const breakBefore = prev !== null && x.note.start_ms - prev.end_ms >= LINE_BREAK_GAP_MS;
      return { ...x, breakBefore };
    });
  }, [notes]);

  useEffect(() => {
    if (!active) {
      if (activeIdxRef.current !== -1) {
        activeIdxRef.current = -1;
        setActiveIdx(-1);
      }
      return;
    }
    let rafId = 0;
    const tick = () => {
      const ms = currentMsRef.current ?? 0;
      let idx = -1;
      for (let i = 0; i < notes.length; i++) {
        if (ms >= notes[i].start_ms && ms < notes[i].end_ms) {
          idx = i;
          break;
        }
      }
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
        <Text style={styles.text}>"{fallbackText || '—'}"</Text>
      </View>
    );
  }

  // Render: opening quote, items separated by spaces (or `\n` at gap
  // boundaries), trailing close quote. RN <Text> respects \n inside a
  // child <Text>, so emitting it as content rather than wrapping in
  // multiple Text blocks keeps the active-syllable highlight inline.
  return (
    <View style={styles.strip}>
      <Text style={styles.text}>
        "
        {items.map((x, i) => {
          const isActive = x.idx === activeIdx;
          const sep = i === 0 ? '' : x.breakBefore ? '\n' : ' ';
          return (
            <Text key={x.idx}>
              {sep}
              <Text style={isActive ? styles.active : undefined}>{x.note.lyric}</Text>
            </Text>
          );
        })}
        "
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    paddingHorizontal: 16,
    paddingVertical: 4,
    alignItems: 'flex-start',
  },
  text: {
    fontFamily: FONTS.monaco,
    fontSize: 13,
    fontWeight: '700',
    paddingHorizontal: 10,
    paddingVertical: 4,
    ...BORDER_1BIT,
    ...SHADOW_1BIT,
    backgroundColor: COLORS.white,
  },
  active: {
    backgroundColor: COLORS.black,
    color: COLORS.white,
  },
});
