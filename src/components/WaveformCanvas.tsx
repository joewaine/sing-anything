import { createElement, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { PitchDetector } from 'pitchy';
import { makeActiveNoteCursor } from '../lib/activeNoteCursor';
import { getAudioContext } from '../lib/audioService';
import type { MidiNote } from '../types';
import { BORDER_1BIT, COLORS, GRID_BG, SHADOW_1BIT } from '../theme';

type Props = {
  stream: MediaStream | null;
  notes: MidiNote[];
  currentMsRef: RefObject<number>;
  active: boolean;
};

// Smaller FFT + cheaper rAF cadence on Android; keeps UI responsive while
// still giving a recognizable live waveform.
const FFT_SIZE = 1024;
// Kept in sync with pitch.ts — 20% more forgiving than a literal quarter tone.
const CLARITY_THRESHOLD = 0.80;
const HIT_CENTS = 60;
const HEIGHT = 130;
// Only check pitch every N frames — the color barely needs to change per-frame
// and pitchy is the most expensive per-frame cost.
const PITCH_EVERY_N_FRAMES = 3;

const IN_TUNE = { r: 57, g: 255, b: 130 };
const OUT_OF_TUNE = { r: 255, g: 90, b: 170 };

function lerpColor(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round(IN_TUNE.r + k * (OUT_OF_TUNE.r - IN_TUNE.r));
  const g = Math.round(IN_TUNE.g + k * (OUT_OF_TUNE.g - IN_TUNE.g));
  const b = Math.round(IN_TUNE.b + k * (OUT_OF_TUNE.b - IN_TUNE.b));
  return `rgb(${r}, ${g}, ${b})`;
}

function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

/** Mobile Android/Chromium can't afford the extra rAF + analyser cost on top
 * of the existing pitch ribbon / lyric strip / count-in loops. Skip it there. */
function isLowPowerDevice(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /android/i.test(ua);
}

export default function WaveformCanvas({
  stream,
  notes,
  currentMsRef,
  active,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ w: 0, h: HEIGHT });

  useEffect(() => {
    if (!active || !stream) return;
    if (isLowPowerDevice()) return;

    const ctx = getAudioContext();
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;

    let source: MediaStreamAudioSourceNode;
    try {
      source = ctx.createMediaStreamSource(stream);
    } catch {
      return;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.35;
    source.connect(analyser);

    const timeData = new Float32Array(analyser.fftSize);
    const detector = PitchDetector.forFloat32Array(analyser.fftSize);

    const c2d = canvas.getContext('2d');
    if (!c2d) return;

    let rafId = 0;
    let frame = 0;
    // Cached `t` between pitch-detection samples so the stroke color stays
    // stable without recomputing every frame.
    let cachedT = 1;
    // Monotonic cursor — replaces a per-frame `notes.find(...)` linear
    // scan (O(N) at 60Hz × 30+ notes was a measurable cost on Android).
    const noteCursor = makeActiveNoteCursor(notes);

    const draw = () => {
      const { w, h } = sizeRef.current;
      if (w === 0 || h === 0) {
        rafId = requestAnimationFrame(draw);
        return;
      }
      analyser.getFloatTimeDomainData(timeData);

      if (frame % PITCH_EVERY_N_FRAMES === 0) {
        let t = 1;
        const ms = currentMsRef.current ?? 0;
        const idx = noteCursor(ms);
        const expected = idx >= 0 ? notes[idx] : null;
        if (expected) {
          const [freq, clarity] = detector.findPitch(timeData, ctx.sampleRate);
          if (freq > 0 && clarity >= CLARITY_THRESHOLD) {
            let diff = freqToMidi(freq) - expected.pitch_midi;
            while (diff > 6) diff -= 12;
            while (diff < -6) diff += 12;
            t = Math.min(1, (Math.abs(diff) * 100) / HIT_CENTS);
          }
        }
        cachedT = t;
      }
      frame += 1;
      const color = lerpColor(cachedT);

      c2d.clearRect(0, 0, w, h);

      // Waveform stroke only — grid + midline live in CSS on the wrapping
      // View, so they don't cost per-frame redraws.
      c2d.beginPath();
      c2d.lineWidth = 1;
      c2d.strokeStyle = color;
      c2d.lineJoin = 'miter';
      c2d.lineCap = 'butt';

      const centerY = h / 2;
      const len = timeData.length;
      const slice = w / len;
      let x = 0;
      for (let i = 0; i < len; i++) {
        const y = centerY + timeData[i] * (h * 0.45);
        if (i === 0) c2d.moveTo(x, y);
        else c2d.lineTo(x, y);
        x += slice;
      }
      c2d.stroke();

      rafId = requestAnimationFrame(draw);
    };
    rafId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafId);
      try {
        source.disconnect();
      } catch {
        // already disconnected
      }
      try {
        analyser.disconnect();
      } catch {
        // already disconnected
      }
    };
  }, [active, stream, notes, currentMsRef]);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w === sizeRef.current.w) return;
    sizeRef.current.w = w;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    canvas.width = w * dpr;
    canvas.height = HEIGHT * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${HEIGHT}px`;
    const c2d = canvas.getContext('2d');
    if (c2d) c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  if (!active) return null;
  if (isLowPowerDevice()) return null;

  const canvasEl = createElement('canvas', {
    ref: canvasRef,
    style: {
      width: '100%',
      height: '100%',
      display: 'block',
      position: 'absolute',
      top: 0,
      left: 0,
    },
  });

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      {/* Grid + midline are CSS, drawn once — no per-frame cost */}
      <View pointerEvents="none" style={styles.gridLayer} />
      <View pointerEvents="none" style={styles.midLine} />
      {canvasEl}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
    width: '100%',
    height: HEIGHT,
    backgroundColor: COLORS.white,
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
});
