// One-time tap-along audio sync calibration.
//
// Plays 6 metronome clicks; the user taps a big button on each one. We
// compare each tap's performance.now() to the click's predicted audible
// performance.now() (scheduled time mapped through ctx.getOutputTimestamp,
// plus ctx.outputLatency) and average the residuals. The residual is
// what ctx.outputLatency under-reports — typically near zero on wired,
// 100–300ms on Bluetooth headphones. Saved to syncOffsetMs so playback
// in done view + takes view applies the corrected offset automatically.

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
const N_BEATS = 6;
// First beat is "cold" — reaction time dominates because the user hasn't
// settled into the rhythm yet. Drop it from the average.
const DROP_FIRST = 1;

type Phase = 'intro' | 'leadin' | 'running' | 'result';

export default function CalibrationScreen({ onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [beatIdx, setBeatIdx] = useState(0);
  const [residualMs, setResidualMs] = useState<number | null>(null);
  const [, setSyncOffset] = useSyncOffset();

  // Per-run state stashed in refs so the rAF/setTimeout chain doesn't
  // close over stale state.
  const expectedPerfTimesRef = useRef<number[]>([]);
  const tapPerfTimesRef = useRef<number[]>([]);
  const oscillatorsRef = useRef<OscillatorNode[]>([]);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const teardown = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
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

  const start = useCallback(() => {
    const ctx = getAudioContext();
    if (!ctx) return;
    teardown();
    expectedPerfTimesRef.current = [];
    tapPerfTimesRef.current = [];
    setBeatIdx(0);
    setResidualMs(null);
    setPhase('leadin');

    const beatSec = 60 / BPM;
    const startAt = ctx.currentTime + 0.8;
    const ts = ctx.getOutputTimestamp();
    // perf time = ctxSec * 1000 + perfAtCtxZero
    const perfAtCtxZero =
      (ts.performanceTime ?? performance.now()) - (ts.contextTime ?? 0) * 1000;
    const outputLatencyMs =
      (typeof ctx.outputLatency === 'number' ? ctx.outputLatency : 0) * 1000;

    for (let i = 0; i < N_BEATS; i++) {
      const ctxTime = startAt + i * beatSec;
      const audiblePerf = ctxTime * 1000 + perfAtCtxZero + outputLatencyMs;
      expectedPerfTimesRef.current.push(audiblePerf);

      // Schedule click — same shape as countInClicks.
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = i === 0 ? 1200 : 800;
      gain.gain.setValueAtTime(0, ctxTime);
      gain.gain.linearRampToValueAtTime(0.18, ctxTime + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctxTime + 0.06);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctxTime);
      osc.stop(ctxTime + 0.07);
      oscillatorsRef.current.push(osc);

      // UI: advance counter when each beat fires.
      const delayToBeatMs = Math.max(0, audiblePerf - performance.now());
      timersRef.current.push(
        setTimeout(() => {
          setBeatIdx(i + 1);
          if (i === 0) setPhase('running');
        }, delayToBeatMs),
      );
    }

    // After all beats + grace, flip to result. If the user missed a tap
    // we still finalize so they can retry.
    const lastBeatPerf =
      expectedPerfTimesRef.current[expectedPerfTimesRef.current.length - 1];
    const finalizeDelay = Math.max(
      0,
      lastBeatPerf - performance.now() + 800,
    );
    timersRef.current.push(setTimeout(finalize, finalizeDelay));
  }, [teardown]);

  const finalize = useCallback(() => {
    const taps = tapPerfTimesRef.current;
    const expected = expectedPerfTimesRef.current;
    if (taps.length < N_BEATS - DROP_FIRST) {
      // Not enough taps — show error-ish result with retry.
      setResidualMs(null);
      setPhase('result');
      return;
    }
    const offsets: number[] = [];
    // Pair each tap to its expected beat by index. If user double-taps
    // or misses, we skip the corresponding pair.
    const N = Math.min(taps.length, expected.length);
    for (let i = DROP_FIRST; i < N; i++) {
      offsets.push(taps[i] - expected[i]);
    }
    if (offsets.length === 0) {
      setResidualMs(null);
      setPhase('result');
      return;
    }
    const avg = offsets.reduce((a, b) => a + b, 0) / offsets.length;
    setResidualMs(Math.round(avg));
    setPhase('result');
  }, []);

  const onTap = useCallback(() => {
    if (phase !== 'leadin' && phase !== 'running') return;
    tapPerfTimesRef.current.push(performance.now());
  }, [phase]);

  const acceptResult = useCallback(() => {
    if (residualMs !== null) {
      setSyncOffset(residualMs);
    }
    onBack();
  }, [residualMs, setSyncOffset, onBack]);

  const reset = useCallback(() => {
    teardown();
    setPhase('intro');
    setBeatIdx(0);
    setResidualMs(null);
  }, [teardown]);

  const tapDisabled = phase !== 'leadin' && phase !== 'running';
  const tapTotal = tapPerfTimesRef.current.length;

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
              Put on your headphones and find a quiet moment. We'll play 6
              clicks at a slow tempo — tap the big button on each click.
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

        {(phase === 'leadin' || phase === 'running') && (
          <View style={styles.center}>
            <Text style={styles.beatCount}>
              {beatIdx} / {N_BEATS}
            </Text>
            <Pressable
              onPressIn={onTap}
              disabled={tapDisabled}
              style={({ pressed }) => [
                styles.tapBox,
                pressed && styles.tapBoxPressed,
              ]}
            >
              <Text style={styles.tapLabel}>TAP</Text>
              <Text style={styles.tapHint}>each time you hear a click</Text>
            </Pressable>
            <Text style={styles.hint}>{tapTotal} taps so far</Text>
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
                  Couldn't get a reading — give it another go.
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
