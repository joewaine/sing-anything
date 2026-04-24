import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
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
const NOTE_HEIGHT = 14;

const MARQUEE_THRESHOLD_MS = 10_000;
const PX_PER_SEC = 80;
const PLAYHEAD_FRACTION = 0.33;
const PLAYHEAD_BAND_WIDTH = 56;

type NoteGeom = {
  x: number;
  w: number;
  y: number;
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
                backgroundImage: g.gradient,
              } as any,
            ]}
          />
          {g.lyric ? (
            <Text
              numberOfLines={1}
              style={[styles.lyric, { left: -20, width: g.w + 40 }]}
            >
              {g.lyric}
            </Text>
          ) : null}
        </View>
      ))}
    </>
  );
}

const MemoNotesLayer = (function () {
  // eslint-disable-next-line react/display-name
  const M = (props: { geometry: NoteGeom[] }) => NotesLayer(props);
  return M;
})();

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

  const minPitch = useMemo(() => {
    if (notes.length === 0) return 60;
    return Math.min(...notes.map((n) => n.pitch_midi));
  }, [notes]);

  const pitchRange = useMemo(() => {
    if (notes.length === 0) return 12;
    const pitches = notes.map((n) => n.pitch_midi);
    return Math.max(3, Math.max(...pitches) - Math.min(...pitches) + 2);
  }, [notes]);

  const innerWidth = useMarquee
    ? (durationMs / 1000) * PX_PER_SEC
    : containerWidth;

  const geometry = useMemo<NoteGeom[]>(() => {
    if (innerWidth === 0 || durationMs <= 0) return [];
    const drawHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
    return notes.map((n, i) => {
      const x = Math.max(0, Math.min(innerWidth, (n.start_ms / durationMs) * innerWidth));
      const end = Math.max(0, Math.min(innerWidth, (n.end_ms / durationMs) * innerWidth));
      const normalized = (n.pitch_midi - minPitch + 1) / pitchRange;
      const y = PAD_TOP + (1 - normalized) * drawHeight - NOTE_HEIGHT / 2;
      return {
        x,
        w: Math.max(4, end - x),
        y,
        lyric: n.lyric ?? '',
        gradient: NOTE_GRADIENTS[i % NOTE_GRADIENTS.length],
        startMs: n.start_ms,
        endMs: n.end_ms,
      };
    });
  }, [notes, innerWidth, durationMs, minPitch, pitchRange]);

  const playheadX = containerWidth * PLAYHEAD_FRACTION;

  // Single rAF loop drives (a) the scroller/cursor transform imperatively
  // and (b) the active-note React state. (a) runs every frame with zero
  // React work; (b) only fires when the active index actually changes.
  useEffect(() => {
    if (!active) return;
    let rafId = 0;
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

      let idx = -1;
      for (let i = 0; i < geometry.length; i++) {
        if (ms >= geometry[i].startMs && ms < geometry[i].endMs) {
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
  }, [active, useMarquee, playheadX, durationMs, containerWidth, geometry, currentMsRef]);

  const onLayout = (e: LayoutChangeEvent) => setContainerWidth(e.nativeEvent.layout.width);

  return (
    <View style={styles.container} onLayout={onLayout}>
      <View style={styles.gridLayer} />
      <View style={styles.midLine} />

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
            { left: -20, width: geom.w + 40 },
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
    height: NOTE_HEIGHT,
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
    top: NOTE_HEIGHT + 4,
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
