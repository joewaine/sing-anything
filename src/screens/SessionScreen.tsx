import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Audio } from 'expo-av';
import Chrome from '../components/Chrome';
import PitchRibbon from '../components/PitchRibbon';
import LyricStrip from '../components/LyricStrip';
import WaveformCanvas from '../components/WaveformCanvas';
import RetroButton from '../components/RetroButton';
import BeatBall from '../components/BeatBall';
import { type PhraseWithSong } from '../lib/phrases';
import { uploadAndInsert, runAnalysisAndSave } from '../lib/attempts';
import { feedbackInlineFor, requestFeedback, type FeedbackResult } from '../lib/feedback';
import { createRecorder, primeMicPermission, type Recorder } from '../lib/recorder';
import { startPhraseLoop, type PhraseLoopHandle } from '../lib/phraseLoop';
import type { PitchAnalysis } from '../lib/pitch';
import { useBackingVolume, nextStep } from '../lib/backingVolume';
import { BORDER_1BIT, COLORS, FONTS, SHADOW_1BIT } from '../theme';

// Stages:
//   loading — phrase audio buffers warming, screen first mounts
//   playing — loop running; user can toggle audio + arm recording
//   armed   — user pressed Record; recording will start at next loop t=0
//   recording — capturing mic audio; auto-stops at end of one full loop
//   done    — analysis + feedback view; loop is paused for focus
//   error
type Stage = 'loading' | 'playing' | 'armed' | 'recording' | 'done' | 'error';

type Props = {
  phrase: PhraseWithSong;
  onBack: () => void;
};

const STAGE_LABELS: Record<Exclude<Stage, 'error'>, string> = {
  loading: 'Loading',
  playing: 'Playing',
  armed: 'Armed',
  recording: 'Recording',
  done: 'Done',
};

export default function SessionScreen({ phrase, onBack }: Props) {
  const [stage, setStage] = useState<Stage>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PitchAnalysis | null>(null);
  const [analysisPending, setAnalysisPending] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackResult | null>(null);
  const [feedbackPending, setFeedbackPending] = useState(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [leadVocalEnabled, setLeadVocalEnabled] = useState(true);
  const [backingEnabled, setBackingEnabled] = useState(true);
  const [backingVolume, setBackingVolume] = useBackingVolume();
  // armCountdownMs is the seconds-until-record-starts shown while armed.
  // Updated from a single rAF tick so it stays in step with the loop.
  const [armCountdownMs, setArmCountdownMs] = useState(0);
  // currentMs lives in a ref so frame-rate updates don't re-render the screen.
  // PitchRibbon / LyricStrip / WaveformCanvas read it imperatively via rAF.
  const currentMsRef = useRef(0);

  const phraseLoopRef = useRef<PhraseLoopHandle | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const playbackRef = useRef<Audio.Sound | null>(null);
  const lastRecordingUriRef = useRef<string | null>(null);
  // Cancellable schedules — both call setTimeouts under the hood. Storing
  // them lets us tear down on cancel/unmount without leaking the timer.
  const cancelArmRef = useRef<(() => void) | null>(null);
  const cancelStopArmRef = useRef<(() => void) | null>(null);
  const armRafRef = useRef<number | null>(null);
  const stopRecordingRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const stopArmRaf = useCallback(() => {
    if (armRafRef.current !== null) {
      cancelAnimationFrame(armRafRef.current);
      armRafRef.current = null;
    }
  }, []);

  const revokeLastRecording = useCallback(() => {
    const uri = lastRecordingUriRef.current;
    lastRecordingUriRef.current = null;
    if (!uri) return;
    if (
      uri.startsWith('blob:') &&
      typeof URL !== 'undefined' &&
      URL.revokeObjectURL
    ) {
      URL.revokeObjectURL(uri);
      return;
    }
    if (uri.startsWith('file://')) {
      void (async () => {
        try {
          const FS = await import('expo-file-system');
          await FS.deleteAsync(uri, { idempotent: true });
        } catch (e) {
          console.warn('native attempt cleanup failed:', e);
        }
      })();
    }
  }, []);

  const teardown = useCallback(() => {
    cancelArmRef.current?.();
    cancelArmRef.current = null;
    cancelStopArmRef.current?.();
    cancelStopArmRef.current = null;
    stopArmRaf();
    phraseLoopRef.current?.stop();
    phraseLoopRef.current = null;
    recorderRef.current?.stop().catch(() => {});
    recorderRef.current = null;
    setMicStream(null);
  }, [stopArmRaf]);

  // Mount: configure audio mode + kick off the loop. Auto-start avoids the
  // "Tap to begin" gate the old Listen flow had — phrase audio plays from
  // the moment the user lands here.
  const startLoop = useCallback(async () => {
    Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
    primeMicPermission().catch(() => {
      // Permission not granted yet — recorder.prepare() will surface a
      // friendly error if Record is pressed before access is allowed.
    });
    try {
      const handle = await startPhraseLoop({
        backingUrl: phrase.backing_url,
        vocalsUrl: phrase.vocals_url,
        loopDurationSec: phrase.duration_ms / 1000,
        backingCacheKey: `${phrase.song_id}:${phrase.id}:backing`,
        vocalsCacheKey: `${phrase.song_id}:${phrase.id}:vocals`,
        backingEnabled,
        backingVolume,
        vocalsEnabled: leadVocalEnabled,
        onPositionMs: (ms) => {
          currentMsRef.current = ms;
        },
      });
      if (!handle) {
        setErrorMsg('Audio not available on this device');
        setStage('error');
        return;
      }
      phraseLoopRef.current = handle;
      setStage('playing');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage('error');
    }
    // backingEnabled / backingVolume / leadVocalEnabled captured at mount;
    // toggle effects below propagate later changes to the live handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phrase]);

  useEffect(() => {
    void startLoop();
    return () => {
      teardown();
      playbackRef.current?.unloadAsync();
      revokeLastRecording();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phrase.id]);

  // Toggles + volume slider — apply to the live loop handle without
  // re-scheduling. Each ramps the relevant gain in ~30ms.
  useEffect(() => {
    phraseLoopRef.current?.setBackingEnabled(backingEnabled);
  }, [backingEnabled]);
  useEffect(() => {
    phraseLoopRef.current?.setBackingVolume(backingVolume);
  }, [backingVolume]);
  useEffect(() => {
    phraseLoopRef.current?.setVocalsEnabled(leadVocalEnabled);
  }, [leadVocalEnabled]);

  const stopRecording = useCallback(async () => {
    cancelStopArmRef.current?.();
    cancelStopArmRef.current = null;
    stopArmRaf();

    const recorder = recorderRef.current;
    if (!recorder) return;

    let uri = '';
    try {
      uri = await recorder.stop();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage('error');
      return;
    }
    recorderRef.current = null;
    setMicStream(null);

    if (!uri) {
      setErrorMsg('No audio captured');
      setStage('error');
      return;
    }
    lastRecordingUriRef.current = uri;

    // Pause the loop so the done view is quiet — the user is reading
    // feedback and replaying their own take, not practicing again yet.
    phraseLoopRef.current?.stop();
    phraseLoopRef.current = null;

    // Snap currentMs to the end of the phrase so the ribbon shows the
    // full take you just sang.
    currentMsRef.current = phrase.duration_ms;

    setStage('done');

    try {
      const { attemptId } = await uploadAndInsert(phrase, uri);

      const { sound } = await Audio.Sound.createAsync({ uri });
      playbackRef.current = sound;
      sound.playAsync().catch(() => {});

      setAnalysisPending(true);
      runAnalysisAndSave(attemptId, phrase.notes, uri).then((a) => {
        setAnalysis(a);
        setAnalysisPending(false);
        if (a) {
          setFeedbackPending(true);
          requestFeedback(attemptId, feedbackInlineFor(phrase, a))
            .then(setFeedback)
            .catch((e) => console.warn('feedback request failed:', e))
            .finally(() => setFeedbackPending(false));
        }
      });
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage('error');
    }
  }, [phrase, stopArmRaf]);

  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  const armRecording = useCallback(async () => {
    const handle = phraseLoopRef.current;
    if (!handle) return;
    setStage('armed');

    if (!recorderRef.current) {
      recorderRef.current = createRecorder();
    }
    const recorder = recorderRef.current;
    // Open the mic in parallel with waiting for the next loop boundary.
    // On Android this may briefly degrade backing audio quality (the OS
    // flips into VOICE_COMMUNICATION mode); on iOS / macOS no effect.
    const preparePromise = recorder.prepare().catch((e) => {
      console.warn('recorder prepare failed:', e);
    });

    cancelArmRef.current = handle.onNextLoopStart(async () => {
      cancelArmRef.current = null;
      stopArmRaf();
      await preparePromise;
      setStage('recording');
      recorder.start().catch((e) => {
        console.warn('recorder start failed:', e);
      });
      setMicStream(recorder.getStream());
      // Auto-stop at the end of this loop — one full take.
      cancelStopArmRef.current = phraseLoopRef.current?.onNextLoopStart(() => {
        cancelStopArmRef.current = null;
        void stopRecordingRef.current();
      }) ?? null;
    });

    // Drive the "Starts in X.Xs" countdown.
    const tick = () => {
      const ms = phraseLoopRef.current?.getMsUntilNextLoop() ?? 0;
      setArmCountdownMs(ms);
      armRafRef.current = requestAnimationFrame(tick);
    };
    armRafRef.current = requestAnimationFrame(tick);
  }, [stopArmRaf]);

  const cancelArm = useCallback(() => {
    cancelArmRef.current?.();
    cancelArmRef.current = null;
    stopArmRaf();
    setArmCountdownMs(0);
    setStage('playing');
  }, [stopArmRaf]);

  const replayTake = useCallback(async () => {
    let sound = playbackRef.current;
    if (!sound) {
      const uri = lastRecordingUriRef.current;
      if (!uri) return;
      const created = await Audio.Sound.createAsync({ uri });
      sound = created.sound;
      playbackRef.current = sound;
    }
    try {
      await sound.replayAsync();
    } catch {
      await sound.setPositionAsync(0).catch(() => {});
      await sound.playAsync().catch(() => {});
    }
  }, []);

  const again = useCallback(async () => {
    setErrorMsg(null);
    setAnalysis(null);
    setAnalysisPending(false);
    setFeedback(null);
    setFeedbackPending(false);
    playbackRef.current?.unloadAsync().catch(() => {});
    playbackRef.current = null;
    revokeLastRecording();
    currentMsRef.current = 0;
    setStage('loading');
    await startLoop();
  }, [revokeLastRecording, startLoop]);

  const loopRunning =
    stage === 'playing' || stage === 'armed' || stage === 'recording';
  const showRibbon = loopRunning || stage === 'done';

  return (
    <Chrome>
      <View style={styles.topBar}>
        <Pressable onPress={onBack}>
          {({ pressed }) => (
            <Text
              style={[
                styles.backLink,
                pressed && { backgroundColor: COLORS.black, color: COLORS.white },
              ]}
            >
              ← songs
            </Text>
          )}
        </Pressable>
      </View>

      <View style={styles.kickerWrap}>
        <Text style={styles.kicker}>
          {(phrase.song.name || '').toUpperCase()}
          {phrase.song.artist ? ` • ${phrase.song.artist.toUpperCase()}` : ''}
        </Text>
      </View>

      {showRibbon && (
        <View style={styles.ribbonWrap}>
          <PitchRibbon
            notes={phrase.notes}
            currentMsRef={currentMsRef}
            durationMs={phrase.duration_ms}
            active={loopRunning}
          />
        </View>
      )}

      <LyricStrip
        notes={phrase.notes}
        currentMsRef={currentMsRef}
        fallbackText={phrase.lyric_text}
        active={loopRunning}
      />

      {stage !== 'error' && <StageIndicator stage={stage} />}

      {stage === 'recording' && (
        <View style={styles.waveformWrap}>
          <WaveformCanvas
            stream={micStream}
            notes={phrase.notes}
            currentMsRef={currentMsRef}
            active
          />
        </View>
      )}

      <View style={styles.stage}>
        {stage === 'loading' && (
          <Text style={styles.savedLabel}>LOADING…</Text>
        )}
        {(stage === 'playing' || stage === 'armed' || stage === 'recording') && (
          <View style={styles.liveControls}>
            <BeatBall bpm={phrase.tempo_bpm ?? 120} active />
            {stage === 'playing' && (
              <RetroButton
                label="● Record"
                onPress={armRecording}
                variant="danger"
                size="lg"
              />
            )}
            {stage === 'armed' && (
              <View style={styles.armRow}>
                <Text style={styles.armLabel}>
                  STARTS IN {(armCountdownMs / 1000).toFixed(1)}s
                </Text>
                <RetroButton label="Cancel" onPress={cancelArm} size="md" />
              </View>
            )}
            {stage === 'recording' && (
              <RetroButton
                label="■ Stop"
                onPress={stopRecording}
                variant="danger"
                size="lg"
              />
            )}
            <View style={styles.toggleRow}>
              <ToggleChip
                label="Backing"
                enabled={backingEnabled}
                onToggle={() => setBackingEnabled((v) => !v)}
              />
              <ToggleChip
                label="Lead vocal"
                enabled={leadVocalEnabled}
                onToggle={() => setLeadVocalEnabled((v) => !v)}
              />
            </View>
            <BackingVolumeControl
              value={backingVolume}
              onChange={setBackingVolume}
            />
          </View>
        )}
        {stage === 'done' && (
          <DoneView
            analysis={analysis}
            analysisPending={analysisPending}
            feedback={feedback}
            feedbackPending={feedbackPending}
            onAgain={again}
            onReplay={replayTake}
          />
        )}
        {stage === 'error' && (
          <View style={styles.doneWrap}>
            <Text style={styles.errorLabel}>{errorMsg}</Text>
            <RetroButton label="Try again" onPress={again} />
          </View>
        )}
      </View>
    </Chrome>
  );
}

function StageIndicator({ stage }: { stage: Stage }) {
  const order: Array<Exclude<Stage, 'error'>> = [
    'loading',
    'playing',
    'armed',
    'recording',
    'done',
  ];
  return (
    <View style={styles.stageRow}>
      {order.map((s) => {
        const isActive = stage === s;
        return (
          <View
            key={s}
            style={[styles.stagePill, isActive && styles.stagePillActive]}
          >
            {isActive && <View style={styles.pulse} />}
            <Text style={[styles.stagePillLabel, isActive && styles.stagePillLabelActive]}>
              {STAGE_LABELS[s].toUpperCase()}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function ToggleChip({
  label,
  enabled,
  onToggle,
}: {
  label: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => [
        styles.toggleChip,
        enabled && styles.toggleChipOn,
        pressed && styles.toggleChipPressed,
      ]}
      hitSlop={6}
    >
      <Text
        style={[
          styles.toggleChipLabel,
          enabled && styles.toggleChipLabelOn,
        ]}
      >
        {enabled ? '◉ ' : '○ '}
        {label}
      </Text>
    </Pressable>
  );
}

function DoneView({
  analysis,
  analysisPending,
  feedback,
  feedbackPending,
  onAgain,
  onReplay,
}: {
  analysis: PitchAnalysis | null;
  analysisPending: boolean;
  feedback: FeedbackResult | null;
  feedbackPending: boolean;
  onAgain: () => void;
  onReplay: () => void;
}) {
  const pct = analysis ? Math.round(analysis.hit_rate * 100) : null;
  const cents = analysis ? Math.round(analysis.avg_abs_cents_off) : null;
  const tilt =
    analysis === null
      ? ''
      : Math.abs(analysis.overall_offset_cents) < 15
        ? 'centered'
        : analysis.overall_offset_cents > 0
          ? 'sharp'
          : 'flat';
  return (
    <View style={styles.doneWrap}>
      {pct !== null ? (
        <View style={{ alignItems: 'center' }}>
          <Text style={styles.pctBig}>{pct}%</Text>
          <View style={styles.onPitchBadge}>
            <Text style={styles.onPitchText}>ON PITCH</Text>
          </View>
          {cents !== null && (
            <Text style={styles.meta}>
              avg {cents}¢ off · {tilt}
            </Text>
          )}
        </View>
      ) : analysisPending ? (
        <View style={{ alignItems: 'center' }}>
          <Text style={styles.savedLabel}>SAVED · ANALYZING…</Text>
        </View>
      ) : (
        <Text style={styles.savedLabel}>SAVED</Text>
      )}
      {feedback ? (
        <View style={styles.feedbackCard}>
          <Text style={styles.feedbackText}>{feedback.feedback}</Text>
          <Text style={styles.feedbackTry}>Try next: {feedback.try_next}</Text>
        </View>
      ) : feedbackPending ? (
        <Text style={styles.feedbackPending}>COACH IS LISTENING…</Text>
      ) : null}
      <View style={styles.controlRow}>
        <RetroButton label="Replay" icon="play" onPress={onReplay} size="md" />
        <RetroButton label="Again" onPress={onAgain} size="md" />
      </View>
    </View>
  );
}

function BackingVolumeControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const pct = Math.round(value * 100);
  return (
    <View style={styles.volumeRow}>
      <Text style={styles.volumeLabel}>BACKING</Text>
      <Pressable
        onPress={() => onChange(nextStep(value, -1))}
        style={({ pressed }) => [
          styles.volumeBtn,
          pressed && styles.volumeBtnPressed,
        ]}
        hitSlop={8}
      >
        <Text style={styles.volumeBtnLabel}>−</Text>
      </Pressable>
      <View style={styles.volumeBar}>
        <View style={[styles.volumeFill, { width: `${pct}%` }]} />
      </View>
      <Pressable
        onPress={() => onChange(nextStep(value, +1))}
        style={({ pressed }) => [
          styles.volumeBtn,
          pressed && styles.volumeBtnPressed,
        ]}
        hitSlop={8}
      >
        <Text style={styles.volumeBtnLabel}>+</Text>
      </Pressable>
      <Text style={styles.volumePct}>{pct}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.black,
    backgroundColor: COLORS.white,
  },
  backLink: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 13,
    textDecorationLine: 'underline',
    paddingHorizontal: 2,
    alignSelf: 'flex-start',
  },
  kickerWrap: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.black,
    alignItems: 'center',
  },
  kicker: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: 2,
    textAlign: 'center',
  },
  ribbonWrap: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
    backgroundColor: COLORS.white,
  },
  waveformWrap: {
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 8,
  },
  stageRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    paddingHorizontal: 16,
    paddingBottom: 6,
    paddingTop: 2,
  },
  stagePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    ...BORDER_1BIT,
    backgroundColor: COLORS.white,
    opacity: 0.4,
  },
  stagePillActive: {
    backgroundColor: COLORS.black,
    opacity: 1,
    ...SHADOW_1BIT,
  },
  pulse: {
    width: 5,
    height: 5,
    borderRadius: 9999,
    backgroundColor: COLORS.white,
  },
  stagePillLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 9,
    letterSpacing: 1,
    color: COLORS.black,
  },
  stagePillLabelActive: { color: COLORS.white },
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
  },
  liveControls: {
    alignItems: 'center',
    gap: 10,
  },
  armRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  armLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 14,
    letterSpacing: 1,
    color: COLORS.black,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
  },
  toggleChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    ...BORDER_1BIT,
    backgroundColor: COLORS.white,
  },
  toggleChipOn: {
    backgroundColor: COLORS.black,
  },
  toggleChipPressed: {
    transform: [{ translateX: 1 }, { translateY: 1 }],
  },
  toggleChipLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: -0.2,
    color: COLORS.black,
  },
  toggleChipLabelOn: {
    color: COLORS.white,
  },
  controlRow: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  doneWrap: { alignItems: 'center', gap: 10, maxWidth: 420, width: '100%' },
  savedLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 12,
    letterSpacing: 2,
    color: COLORS.softGrey,
  },
  pctBig: {
    fontFamily: FONTS.pixel,
    fontSize: 56,
    lineHeight: 56,
  },
  onPitchBadge: {
    ...BORDER_1BIT,
    backgroundColor: COLORS.black,
    paddingHorizontal: 7,
    paddingVertical: 1,
    marginTop: 2,
  },
  onPitchText: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 9,
    letterSpacing: 2,
    color: COLORS.white,
  },
  meta: { fontFamily: FONTS.monaco, fontSize: 11, marginTop: 4 },
  feedbackCard: {
    ...BORDER_1BIT,
    ...SHADOW_1BIT,
    backgroundColor: COLORS.white,
    padding: 10,
    gap: 6,
    width: '100%',
  },
  feedbackText: {
    fontFamily: FONTS.chicago,
    fontWeight: '500',
    fontSize: 13,
    lineHeight: 17,
  },
  feedbackTry: {
    fontFamily: FONTS.monaco,
    fontSize: 10,
    fontStyle: 'italic',
    lineHeight: 14,
    color: COLORS.black,
  },
  feedbackPending: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 10,
    letterSpacing: 2,
    color: COLORS.softGrey,
  },
  errorLabel: {
    fontFamily: FONTS.monaco,
    fontSize: 12,
    textAlign: 'center',
    color: '#c00',
    maxWidth: 280,
  },
  volumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  volumeLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 10,
    letterSpacing: 1,
    color: COLORS.black,
  },
  volumeBtn: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    ...BORDER_1BIT,
    backgroundColor: COLORS.white,
  },
  volumeBtnPressed: {
    transform: [{ translateX: 1 }, { translateY: 1 }],
  },
  volumeBtnLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 14,
    color: COLORS.black,
    lineHeight: 14,
  },
  volumeBar: {
    width: 80,
    height: 8,
    ...BORDER_1BIT,
    backgroundColor: COLORS.white,
    overflow: 'hidden',
  },
  volumeFill: {
    height: '100%',
    backgroundColor: COLORS.black,
  },
  volumePct: {
    fontFamily: FONTS.monaco,
    fontSize: 10,
    width: 32,
    color: COLORS.black,
  },
});
