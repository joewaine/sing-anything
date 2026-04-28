// Open-ended tap-along audio sync calibration.
//
// Plays a steady metronome and waits for the user to tap along. We
// match each tap to the nearest scheduled beat (within VALID_WINDOW)
// and average the resulting offsets. As soon as we have enough good
// taps the run finalizes automatically. No time limit — keep tapping
// at your own pace; the click loop runs until you've supplied enough
// matches or hit "Stop".
//
// The mean residual is what ctx.outputLatency under-reports — typically
// near zero on wired, 100–300ms on Bluetooth headphones. Saved to
// syncOffsetMs so playback in done view + takes view applies the
// corrected offset automatically.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Chrome from '../components/Chrome';
import RetroButton from '../components/RetroButton';
import { getAudioContext } from '../lib/audioService';
import { useSyncOffset } from '../lib/syncOffset';
import { BORDER_1BIT, COLORS, FONTS, SHADOW_1BIT } from '../theme';

type Props = {
  onBack: () => void;
};

const BPM = 100;
const TARGET_GOOD_TAPS = 5;
// A tap is "good" if its distance to the nearest beat is under this.
// 400ms ≈ ±0.4 of a beat at 100 BPM — generous enough that a user
// who's a half-beat off still gets credit, tight enough that random
// taps don't pollute the average.
const VALID_WINDOW_MS = 400;
// Drop the first matched tap from the average — cold reaction time
// dominates before the user settles into the rhythm.
const DROP_FIRST_GOOD = 1;
// Schedule beats in chunks; refill as the running schedule gets short.
const CHUNK_SIZE = 16;

type Phase = 'intro' | 'running' | 'result';

type Beat = {
  ctxTime: number;
  audiblePerf: number;
};

export default function CalibrationScreen({ onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [goodCount, setGoodCount] = useState(0);
  const [residualMs, setResidualMs] = useState<number | null>(null);
  const [, setSyncOffset] = useSyncOffset();

  const beatsRef = useRef<Beat[]>([]);
  const matchedRef = useRef<Set<number>>(new Set());
  const offsetsRef = useRef<number[]>([]);
  const oscillatorsRef = useRef<OscillatorNode[]>([]);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const refillTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);

  const teardown = useCallback(() => {
    stoppedRef.current = true;
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    if (refillTimerRef.current) clearTimeout(refillTimerRef.current);
    refillTimerRef.current = null;
    oscillatorsRef.current.forEach((o) => {
      try {
        o.stop();
      } catch {
        // already stopped
      }
    });
    oscillatorsRef.current = [];
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const finalize = useCallback(() => {
    teardown();
    const offsets = offsetsRef.current;
    const usable = offsets.slice(DROP_FIRST_GOOD);
    if (usable.length === 0) {
      setResidualMs(null);
      setPhase('result');
      return;
    }
    const avg = usable.reduce((a, b) => a + b, 0) / usable.length;
    setResidualMs(Math.round(avg));
    setPhase('result');
  }, [teardown]);

  // Schedule N more beats starting from the next slot. Called once on
  // start and again whenever we're getting close to running out.
  const scheduleChunk = useCallback((n: number) => {
    const ctx = getAudioContext();
    if (!ctx || stoppedRef.current) return;
    const beatSec = 60 / BPM;

    // First beat is either right after startAt (initial chunk) or
    // immediately after the last scheduled beat (refill).
    const last = beatsRef.current[beatsRef.current.length - 1];
    const firstCtxTime =
      last !== undefined ? last.ctxTime + beatSec : ctx.currentTime + 0.8;

    const ts = ctx.getOutputTimestamp();
    const perfAtCtxZero =
      (ts.performanceTime ?? performance.now()) - (ts.contextTime ?? 0) * 1000;
    const outputLatencyMs =
      (typeof ctx.outputLatency === 'number' ? ctx.outputLatency : 0) * 1000;

    for (let i = 0; i < n; i++) {
      const ctxTime = firstCtxTime + i * beatSec;
      const audiblePerf = ctxTime * 1000 + perfAtCtxZero + outputLatencyMs;
      beatsRef.current.push({ ctxTime, audiblePerf });

      // Click: same square-osc shape as countInClicks.
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = i % 4 === 0 ? 1200 : 800;
      gain.gain.setValueAtTime(0, ctxTime);
      gain.gain.linearRampToValueAtTime(0.18, ctxTime + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctxTime + 0.06);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctxTime);
      osc.stop(ctxTime + 0.07);
      oscillatorsRef.current.push(osc);
    }

    // Schedule a refill when we're 3 beats away from running out.
    const lastBeatPerf =
      beatsRef.current[beatsRef.current.length - 1].audiblePerf;
    const refillAtPerf = lastBeatPerf - 3 * beatSec * 1000;
    const refillDelayMs = Math.max(0, refillAtPerf - performance.now());
    if (refillTimerRef.current) clearTimeout(refillTimerRef.current);
    refillTimerRef.current = setTimeout(() => {
      if (!stoppedRef.current) scheduleChunk(CHUNK_SIZE);
    }, refillDelayMs);
  }, []);

  const start = useCallback(() => {
    teardown();
    stoppedRef.current = false;
    beatsRef.current = [];
    matchedRef.current = new Set();
    offsetsRef.current = [];
    setGoodCount(0);
    setResidualMs(null);
    setPhase('running');
    scheduleChunk(CHUNK_SIZE);
  }, [scheduleChunk, teardown]);

  const onTap = useCallback(() => {
    if (phase !== 'running') return;
    const tapPerf = performance.now();
    const beats = beatsRef.current;

    // Find nearest beat that hasn't already been matched. Scanning
    // forward is fine — the schedule is dense (~600ms per beat) and
    // bounded by CHUNK_SIZE ahead.
    let nearestIdx = -1;
    let nearestDist = Infinity;
    for (let i = 0; i < beats.length; i++) {
      if (matchedRef.current.has(i)) continue;
      const dist = Math.abs(tapPerf - beats[i].audiblePerf);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }

    if (nearestIdx < 0 || nearestDist > VALID_WINDOW_MS) {
      // Random tap, doesn't match a beat — ignore. The user gets
      // visible feedback via the press animation but no progress.
      return;
    }
    matchedRef.current.add(nearestIdx);
    const offset = tapPerf - beats[nearestIdx].audiblePerf;
    offsetsRef.current.push(offset);
    const count = offsetsRef.current.length;
    setGoodCount(count);

    // Need DROP_FIRST_GOOD discarded + TARGET_GOOD_TAPS counted = total
    // before we can finalize. Without DROP_FIRST_GOOD this is just
    // TARGET_GOOD_TAPS.
    if (count >= TARGET_GOOD_TAPS + DROP_FIRST_GOOD) {
      finalize();
    }
  }, [phase, finalize]);

  const acceptResult = useCallback(() => {
    if (residualMs !== null) {
      setSyncOffset(residualMs);
    }
    onBack();
  }, [residualMs, setSyncOffset, onBack]);

  const reset = useCallback(() => {
    teardown();
    setPhase('intro');
    setGoodCount(0);
    setResidualMs(null);
  }, [teardown]);

  const usableTarget = TARGET_GOOD_TAPS;
  const usableCount = Math.max(0, goodCount - DROP_FIRST_GOOD);

  return (
    <Chrome>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Audio sync</Text>
          <RetroButton label="Back" onPress={onBack} size="sm" />
        </View>

        {phase === 'intro' && (
          <View style={styles.center}>
            <Text style={styles.instructions}>
              Put on your headphones. The metronome will keep clicking — tap
              the big button along with the beat. We'll auto-finish once
              we have enough good taps.
            </Text>
            <Text style={styles.hint}>
              This calibrates for your output latency, especially helpful
              on Bluetooth headphones where the browser under-reports.
              Re-run any time you switch devices.
            </Text>
            <RetroButton
              label="Start"
              icon="play"
              onPress={start}
              size="lg"
              variant="dark"
            />
          </View>
        )}

        {phase === 'running' && (
          <View style={styles.center}>
            <Text style={styles.beatCount}>
              {usableCount} / {usableTarget}
            </Text>
            <Pressable
              onPressIn={onTap}
              style={({ pressed }) => [
                styles.tapBox,
                pressed && styles.tapBoxPressed,
              ]}
            >
              <Text style={styles.tapLabel}>TAP</Text>
              <Text style={styles.tapHint}>each click</Text>
            </Pressable>
            <RetroButton
              label="Stop"
              onPress={finalize}
              size="md"
              variant="danger"
            />
          </View>
        )}

        {phase === 'result' && (
          <View style={styles.center}>
            {residualMs !== null ? (
              <>
                <Text style={styles.resultLabel}>DETECTED OFFSET</Text>
                <Text style={styles.resultBig}>
                  {residualMs >= 0 ? '+' : ''}
                  {residualMs} ms
                </Text>
                <Text style={styles.hint}>
                  {Math.abs(residualMs) < 30
                    ? 'Looks like wired or low-latency output — minimal adjustment.'
                    : residualMs >= 100
                      ? 'Looks like Bluetooth — saving will compensate for the lag.'
                      : 'Small adjustment — saving will tune playback sync.'}
                </Text>
                <View style={styles.row}>
                  <RetroButton
                    label="Save"
                    onPress={acceptResult}
                    size="md"
                    variant="dark"
                  />
                  <RetroButton label="Try again" onPress={reset} size="md" />
                </View>
              </>
            ) : (
              <>
                <Text style={styles.resultLabel}>NOT ENOUGH TAPS</Text>
                <Text style={styles.hint}>
                  No taps landed on the beat. Try again — you'll see a
                  counter tick up as your taps line up with each click.
                </Text>
                <RetroButton label="Try again" onPress={reset} size="md" />
              </>
            )}
          </View>
        )}
      </View>
    </Chrome>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.black,
    marginBottom: 12,
    gap: 10,
  },
  title: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 20,
    letterSpacing: -0.3,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 12,
  },
  instructions: {
    fontFamily: FONTS.chicago,
    fontWeight: '500',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    maxWidth: 360,
  },
  hint: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.softGrey,
    textAlign: 'center',
    maxWidth: 380,
    lineHeight: 16,
  },
  beatCount: {
    fontFamily: FONTS.pixel,
    fontSize: 56,
    lineHeight: 56,
    color: COLORS.black,
  },
  tapBox: {
    width: 220,
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
    ...BORDER_1BIT,
    ...SHADOW_1BIT,
    gap: 4,
  },
  tapBoxPressed: {
    transform: [{ translateX: 1 }, { translateY: 1 }],
    backgroundColor: COLORS.black,
  },
  tapLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 36,
    letterSpacing: 4,
    color: COLORS.black,
  },
  tapHint: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.softGrey,
  },
  resultLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 12,
    letterSpacing: 2,
    color: COLORS.softGrey,
  },
  resultBig: {
    fontFamily: FONTS.pixel,
    fontSize: 48,
    lineHeight: 48,
    color: COLORS.black,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
});
