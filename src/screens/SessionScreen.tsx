import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Audio, type AVPlaybackStatus } from 'expo-av';
import Chrome from '../components/Chrome';
import PitchRibbon from '../components/PitchRibbon';
import LyricStrip from '../components/LyricStrip';
import WaveformCanvas from '../components/WaveformCanvas';
import RetroButton from '../components/RetroButton';
import { type PhraseWithSong } from '../lib/phrases';
import { uploadAndInsert, runAnalysisAndSave } from '../lib/attempts';
import { feedbackInlineFor, requestFeedback, type FeedbackResult } from '../lib/feedback';
import { createRecorder, primeMicPermission, type Recorder } from '../lib/recorder';
import { startCountInAndBacking, type CountInHandleWithVocals } from '../lib/countIn';
import { prefetchBuffer } from '../lib/audioService';
import type { PitchAnalysis } from '../lib/pitch';
import { BORDER_1BIT, COLORS, FONTS, SHADOW_1BIT } from '../theme';

type Stage =
  | 'idle'
  | 'listening'
  | 'countdown'
  | 'recording'
  | 'done'
  | 'error';

type Props = {
  phrase: PhraseWithSong;
  onBack: () => void;
};

const BACKING_VOLUME = 0.55;
const STAGE_LABELS: Record<Exclude<Stage, 'error'>, string> = {
  idle: 'Ready',
  listening: 'Listening…',
  countdown: 'Count in',
  recording: 'Recording',
  done: 'Done',
};

export default function SessionScreen({ phrase, onBack }: Props) {
  const [stage, setStage] = useState<Stage>('idle');
  const [countdown, setCountdown] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PitchAnalysis | null>(null);
  const [analysisPending, setAnalysisPending] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackResult | null>(null);
  const [feedbackPending, setFeedbackPending] = useState(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  // Default to ON — the lead vocal acts as a guide track during recording.
  // User can mute mid-take via the toggle; the gain ramps to 0 without
  // re-decoding or re-scheduling.
  const [leadVocalEnabled, setLeadVocalEnabled] = useState(true);
  const [listenPaused, setListenPaused] = useState(false);
  // currentMs lives in a ref so frame-rate updates don't re-render the screen.
  // PitchRibbon reads it imperatively via rAF.
  const currentMsRef = useRef(0);

  const referenceRef = useRef<Audio.Sound | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const countInRef = useRef<CountInHandleWithVocals | null>(null);
  const listenClockRef = useRef<{
    pause: () => void;
    resume: () => void;
    reset: () => void;
  } | null>(null);
  const playbackRef = useRef<Audio.Sound | null>(null);
  const lastRecordingUriRef = useRef<string | null>(null);
  const listenRafRef = useRef<number | null>(null);
  const stopRecordingRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const stopListenTicker = useCallback(() => {
    if (listenRafRef.current !== null) {
      cancelAnimationFrame(listenRafRef.current);
      listenRafRef.current = null;
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
    // Native: expo-av writes recordings to a file:// path inside the
    // app's cache. Without explicit cleanup these accumulate ~2-3MB per
    // attempt and can balloon a long practice session into hundreds of
    // MB. Lazy-import so the web bundle doesn't carry expo-file-system
    // for browsers that don't need it.
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

  useEffect(() => {
    Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
    return () => {
      referenceRef.current?.unloadAsync();
      playbackRef.current?.unloadAsync();
      recorderRef.current?.stop().catch(() => {});
      countInRef.current?.stop();
      stopListenTicker();
      revokeLastRecording();
    };
  }, [revokeLastRecording, stopListenTicker]);

  const reset = useCallback(() => {
    setErrorMsg(null);
    setAnalysis(null);
    setAnalysisPending(false);
    setFeedback(null);
    setFeedbackPending(false);
    (currentMsRef.current = 0);
    // Unload any playback sound + revoke blob URL so next session starts clean
    playbackRef.current?.unloadAsync().catch(() => {});
    playbackRef.current = null;
    revokeLastRecording();
    setStage('idle');
  }, [revokeLastRecording]);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    countInRef.current?.stop();
    countInRef.current = null;

    let uri = '';
    try {
      uri = await recorder.stop();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage('error');
      return;
    }
    recorderRef.current = null;
    currentMsRef.current = phrase.duration_ms;

    if (!uri) {
      setErrorMsg('No audio captured');
      setStage('error');
      return;
    }
    lastRecordingUriRef.current = uri;

    try {
      // Upload + insert (fast, network-bound). Transition to done immediately.
      const { attemptId } = await uploadAndInsert(phrase, uri);

      // Start local playback of the just-recorded take right away.
      const { sound } = await Audio.Sound.createAsync({ uri });
      playbackRef.current = sound;
      sound.playAsync().catch(() => {});

      setStage('done');

      // Analysis runs in the background — UI is already on done.
      setAnalysisPending(true);
      runAnalysisAndSave(attemptId, phrase.notes, uri).then((a) => {
        setAnalysis(a);
        setAnalysisPending(false);
        if (a) {
          setFeedbackPending(true);
          // Pass pitch_analysis + phrase metadata inline so the edge
          // function skips its DB-read round trip — saves ~150-500ms on
          // the take's critical path.
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
  }, [phrase]);

  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  const playReference = useCallback(async () => {
    // Prompt for mic permission inside the user-gesture handler. The
    // browser caches the grant per-origin, so this fires the permission
    // prompt only on the very first take per origin; later takes find
    // the permission already granted and skip the dialog. Critical to
    // do this BEFORE count-in: prompting mid-countdown was causing the
    // 4 beats to elapse without the mic ever being acquired (race
    // between getUserMedia awaiting user click and onBackingStart).
    // primeMicPermission stops the stream immediately so Android's
    // VOICE_COMMUNICATION pipeline doesn't degrade reference playback.
    primeMicPermission().catch(() => {
      // Permission denied — recorder.prepare() will surface a friendly
      // error during countdown. Don't block Listen on this.
    });

    setStage('listening');
    setListenPaused(false);
    (currentMsRef.current = 0);

    // IMPORTANT — do NOT acquire the mic here. Android flips the device into
    // VOICE_COMMUNICATION audio mode the moment a mic stream exists, which
    // downsamples all playback to voice-band quality (slow/out-of-tune/crackly).
    // We defer recorder.prepare() to startCountdown so Listen-stage playback
    // stays in music-mode. The count-in clicks give us a ~2s window to warm
    // the mic before backing + recording actually start.

    // Warm both the backing AND vocals AudioBuffer caches — by count-in
    // time they're ready, so the count-in→backing transition has zero
    // first-byte fetch wait. Cache keys are (song_id, phrase_id, stem)
    // so a re-signed signed URL still hits the same decoded buffer.
    const cacheKeyFor = (stem: 'vocals' | 'backing') =>
      `${phrase.song_id}:${phrase.id}:${stem}`;
    if (phrase.backing_url) {
      prefetchBuffer(phrase.backing_url, cacheKeyFor('backing'));
    }
    if (phrase.vocals_url) {
      prefetchBuffer(phrase.vocals_url, cacheKeyFor('vocals'));
    }

    const { sound } = await Audio.Sound.createAsync({
      uri: phrase.vocals_url,
    });
    referenceRef.current = sound;

    sound.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => {
      if (!status.isLoaded) return;
      if (status.didJustFinish) {
        stopListenTicker();
        startCountdown();
      }
    });
    await sound.playAsync();

    // Drive currentMsRef at 60Hz for smooth cursor motion (expo-av's own
    // status callbacks only fire at ~20Hz, which looks chunky). Tracking
    // base + accumulated lets us pause without losing position.
    let base = performance.now();
    let accumulated = 0;
    listenClockRef.current = {
      pause() {
        accumulated += performance.now() - base;
        if (listenRafRef.current !== null) cancelAnimationFrame(listenRafRef.current);
        listenRafRef.current = null;
      },
      resume() {
        base = performance.now();
        if (listenRafRef.current === null) {
          const tick = () => {
            currentMsRef.current = accumulated + (performance.now() - base);
            listenRafRef.current = requestAnimationFrame(tick);
          };
          listenRafRef.current = requestAnimationFrame(tick);
        }
      },
      reset() {
        base = performance.now();
        accumulated = 0;
        currentMsRef.current = 0;
      },
    };
    listenClockRef.current.resume();
  }, [phrase]);

  const pauseListen = useCallback(async () => {
    if (!referenceRef.current) return;
    await referenceRef.current.pauseAsync().catch(() => {});
    listenClockRef.current?.pause();
    setListenPaused(true);
  }, []);

  const resumeListen = useCallback(async () => {
    if (!referenceRef.current) return;
    listenClockRef.current?.resume();
    await referenceRef.current.playAsync().catch(() => {});
    setListenPaused(false);
  }, []);

  const restartListen = useCallback(async () => {
    if (!referenceRef.current) return;
    await referenceRef.current.setPositionAsync(0).catch(() => {});
    listenClockRef.current?.reset();
    if (listenPaused) {
      // user explicitly hit restart while paused — keep paused state
      return;
    }
    await referenceRef.current.playAsync().catch(() => {});
  }, [listenPaused]);

  const restartRecording = useCallback(async () => {
    // Abort the in-progress take and re-enter count-in. We discard the
    // partial recording (it'd be unaligned anyway).
    countInRef.current?.stop();
    countInRef.current = null;
    try {
      await recorderRef.current?.stop();
    } catch {
      // Recorder might not be in a stoppable state — ignore.
    }
    recorderRef.current = null;
    setMicStream(null);
    currentMsRef.current = 0;
    // Re-enter the same flow that started the original take.
    void startCountdown();
  }, []);

  const startCountdown = useCallback(async () => {
    setStage('countdown');
    (currentMsRef.current = 0);
    setCountdown(0);

    // Acquire the mic NOW (during the 4-beat count-in window). This is
    // the earliest point we can activate the mic without degrading the
    // reference vocal's playback quality. Permission was already
    // requested in playReference() so this should resolve in
    // ~50-200ms (no prompt, just hardware open). We track the
    // promise so onBackingStart can await it before reporting the
    // stream to the WaveformCanvas — fire-and-forget meant the
    // waveform sometimes saw `null` because prepare hadn't finished.
    if (!recorderRef.current) {
      recorderRef.current = createRecorder();
    }
    const recorder = recorderRef.current;
    const preparePromise = recorder.prepare().catch((e) => {
      console.warn('recorder prepare failed:', e);
    });

    const bpm = phrase.tempo_bpm ?? 120;
    const backingUrl = phrase.backing_url;

    try {
      countInRef.current = await startCountInAndBacking({
        bpm,
        beats: 4,
        backingUrl,
        backingVolume: BACKING_VOLUME,
        backingCacheKey: `${phrase.song_id}:${phrase.id}:backing`,
        vocalsUrl: phrase.vocals_url,
        vocalsEnabled: leadVocalEnabled,
        vocalsCacheKey: `${phrase.song_id}:${phrase.id}:vocals`,
        onBeat: (n) => setCountdown(n),
        onBackingStart: async () => {
          setStage('recording');
          // Wait for prepare() to fully resolve before reading
          // getStream() — otherwise WaveformCanvas receives null and
          // never draws. Worst-case adds the prepare-tail to the take
          // start (~50-200ms with permission cached).
          await preparePromise;
          recorder.start().catch((e) => {
            console.warn('recorder start failed:', e);
          });
          setMicStream(recorder.getStream());
        },
        onPositionMs: (ms) => {
          currentMsRef.current = ms;
        },
        onBackingEnd: () => {
          setTimeout(() => stopRecordingRef.current(), 0);
        },
      });
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage('error');
    }
  }, [phrase, leadVocalEnabled]);

  // When the toggle flips mid-take, ramp the existing gain instead of
  // re-scheduling — no audible re-trigger and no buffer re-decode.
  useEffect(() => {
    countInRef.current?.setVocalsEnabled(leadVocalEnabled);
  }, [leadVocalEnabled]);

  const showRibbon = stage !== 'idle' && stage !== 'error';

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
            active={stage === 'listening' || stage === 'recording'}
          />
        </View>
      )}

      <LyricStrip
        notes={phrase.notes}
        currentMsRef={currentMsRef}
        fallbackText={phrase.lyric_text}
        active={stage === 'listening' || stage === 'recording'}
      />

      {stage !== 'error' && <StageIndicator stage={stage} countdown={countdown} />}

      {stage === 'recording' && (
        <View style={styles.waveformWrap}>
          <WaveformCanvas
            stream={micStream}
            notes={phrase.notes}
            currentMsRef={currentMsRef}
            active={stage === 'recording'}
          />
          <Pressable
            onPress={() => setLeadVocalEnabled((v) => !v)}
            style={({ pressed }) => [
              styles.vocalToggle,
              leadVocalEnabled && styles.vocalToggleOn,
              pressed && styles.vocalTogglePressed,
            ]}
            hitSlop={6}
          >
            <Text
              style={[
                styles.vocalToggleLabel,
                leadVocalEnabled && styles.vocalToggleLabelOn,
              ]}
            >
              {leadVocalEnabled ? '🎤 Lead vocal: ON' : '🎤 Lead vocal: off'}
            </Text>
          </Pressable>
        </View>
      )}

      <View style={styles.stage}>
        {stage === 'idle' && (
          <>
            <RetroButton label="Listen" icon="play" onPress={playReference} size="lg" />
            <Text style={styles.hint}>🎧 headphones recommended</Text>
          </>
        )}
        {stage === 'listening' && (
          <View style={styles.controlRow}>
            <RetroButton
              label={listenPaused ? 'Resume' : 'Pause'}
              icon={listenPaused ? 'play' : null}
              onPress={listenPaused ? resumeListen : pauseListen}
              size="md"
            />
            <RetroButton label="Restart" onPress={restartListen} size="md" />
          </View>
        )}
        {stage === 'countdown' && (
          <Text style={styles.countdown}>{countdown || ' '}</Text>
        )}
        {stage === 'recording' && (
          <View style={styles.controlRow}>
            <RetroButton label="Restart" onPress={restartRecording} size="md" />
            <RetroButton label="Stop" onPress={stopRecording} variant="danger" size="md" />
          </View>
        )}
        {stage === 'done' && (
          <DoneView
            analysis={analysis}
            analysisPending={analysisPending}
            feedback={feedback}
            feedbackPending={feedbackPending}
            onAgain={reset}
          />
        )}
        {stage === 'error' && (
          <View style={styles.doneWrap}>
            <Text style={styles.errorLabel}>{errorMsg}</Text>
            <RetroButton label="Try again" onPress={reset} />
          </View>
        )}
      </View>
    </Chrome>
  );
}

function StageIndicator({
  stage,
  countdown,
}: {
  stage: Stage;
  countdown: number;
}) {
  const order: Array<Exclude<Stage, 'error'>> = [
    'idle',
    'listening',
    'countdown',
    'recording',
    'done',
  ];
  return (
    <View style={styles.stageRow}>
      {order.map((s) => {
        const isActive = stage === s;
        const label =
          s === 'countdown' && stage === 'countdown' && countdown > 0
            ? `${countdown}`
            : STAGE_LABELS[s];
        return (
          <View
            key={s}
            style={[styles.stagePill, isActive && styles.stagePillActive]}
          >
            {isActive && <View style={styles.pulse} />}
            <Text style={[styles.stagePillLabel, isActive && styles.stagePillLabelActive]}>
              {label.toUpperCase()}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function DoneView({
  analysis,
  analysisPending,
  feedback,
  feedbackPending,
  onAgain,
}: {
  analysis: PitchAnalysis | null;
  analysisPending: boolean;
  feedback: FeedbackResult | null;
  feedbackPending: boolean;
  onAgain: () => void;
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
      <RetroButton label="Again" onPress={onAgain} size="lg" />
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
  vocalToggle: {
    alignSelf: 'flex-end',
    marginTop: 8,
    marginRight: 0,
    paddingHorizontal: 12,
    paddingVertical: 6,
    ...BORDER_1BIT,
    backgroundColor: COLORS.white,
  },
  vocalToggleOn: {
    backgroundColor: COLORS.black,
  },
  vocalTogglePressed: {
    transform: [{ translateX: 1 }, { translateY: 1 }],
  },
  vocalToggleLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: -0.2,
    color: COLORS.black,
  },
  vocalToggleLabelOn: {
    color: COLORS.white,
  },
  lyricStrip: {
    paddingHorizontal: 16,
    paddingVertical: 4,
    alignItems: 'flex-start',
  },
  lyricText: {
    fontFamily: FONTS.monaco,
    fontSize: 13,
    fontWeight: '700',
    paddingHorizontal: 10,
    paddingVertical: 4,
    ...BORDER_1BIT,
    ...SHADOW_1BIT,
    backgroundColor: COLORS.white,
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
  stageLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 14,
    letterSpacing: 1,
  },
  countdown: {
    fontFamily: FONTS.pixel,
    fontSize: 96,
    lineHeight: 96,
    color: COLORS.black,
  },
  hint: { fontFamily: FONTS.monaco, fontSize: 12 },
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
});
