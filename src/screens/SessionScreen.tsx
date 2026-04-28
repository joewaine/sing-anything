import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Audio } from 'expo-av';
import Chrome from '../components/Chrome';
import PitchRibbon from '../components/PitchRibbon';
import LyricStrip from '../components/LyricStrip';
import WaveformCanvas from '../components/WaveformCanvas';
import RetroButton from '../components/RetroButton';
import { type PhraseWithSong } from '../lib/phrases';
import { uploadAndInsert, runAnalysisAndSave } from '../lib/attempts';
import { feedbackInlineFor, requestFeedback, type FeedbackResult } from '../lib/feedback';
import { createRecorder, primeMicPermission, type Recorder } from '../lib/recorder';
import { startPhraseLoop, type PhraseLoopHandle } from '../lib/phraseLoop';
import { startCountIn, type CountInHandle } from '../lib/countInClicks';
import { getAudioContext } from '../lib/audioService';
import type { PitchAnalysis } from '../lib/pitch';
import { useBackingVolume, nextStep } from '../lib/backingVolume';
import {
  useSyncOffset,
  SYNC_OFFSET_STEP_MS,
  SYNC_OFFSET_MIN_MS,
  SYNC_OFFSET_MAX_MS,
} from '../lib/syncOffset';
import { BORDER_1BIT, COLORS, FONTS, SHADOW_1BIT } from '../theme';

/**
 * Build the aligned (loop-length, head-shifted) recording buffer.
 * `extraOffsetMs` is the user-adjustable sync nudge — layered on top
 * of the auto-detected output latency to cope with Bluetooth headphone
 * latency the browser may under-report. Pulled into a file-level
 * helper so the syncOffset effect can rebuild without re-fetching
 * the recording or duplicating the math from takePlayback.ts.
 */
function buildAlignedRecording(
  ctx: AudioContext,
  raw: AudioBuffer,
  loopDurationSec: number,
  extraOffsetMs: number,
): AudioBuffer {
  const targetLength = Math.max(
    1,
    Math.round(loopDurationSec * raw.sampleRate),
  );
  const autoHeadOffsetSec = 0.05 + Math.max(0, ctx.outputLatency ?? 0);
  const totalOffsetSec = Math.max(0, autoHeadOffsetSec + extraOffsetMs / 1000);
  const headOffsetSamples = Math.max(
    0,
    Math.round(totalOffsetSec * raw.sampleRate),
  );
  const aligned = ctx.createBuffer(
    raw.numberOfChannels,
    targetLength,
    raw.sampleRate,
  );
  for (let ch = 0; ch < raw.numberOfChannels; ch++) {
    const src = raw.getChannelData(ch);
    const dst = aligned.getChannelData(ch);
    const copyLen = Math.min(src.length, targetLength - headOffsetSamples);
    if (copyLen > 0) {
      dst.set(src.subarray(0, copyLen), headOffsetSamples);
    }
  }
  return aligned;
}

// Stages:
//   loading — phrase audio buffers warming, screen first mounts
//   playing — loop running; user can toggle audio + start recording
//   countdown — 4-beat metronome before recording, loop paused
//   recording — capturing mic audio; ends only on Stop
//   done    — analysis + feedback view; loop is paused for focus
//   error
type Stage = 'loading' | 'playing' | 'countdown' | 'recording' | 'done' | 'error';

type Props = {
  phrase: PhraseWithSong;
  onBack: () => void;
};

const STAGE_LABELS: Record<Exclude<Stage, 'error'>, string> = {
  loading: 'Loading',
  playing: 'Playing',
  countdown: 'Count in',
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
  const [syncOffsetMs, setSyncOffsetMs] = useSyncOffset();
  // Toggle for the user's own recorded take during done-view playback.
  // Default on — the whole point of done view is hearing yourself.
  const [yourTakeEnabled, setYourTakeEnabled] = useState(true);
  const currentMsRef = useRef(0);

  const phraseLoopRef = useRef<PhraseLoopHandle | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const playbackRef = useRef<Audio.Sound | null>(null);
  // For done-view replay on web we play the recording through Web
  // Audio (decoded into a buffer) so it shares the same clock as the
  // backing loop — sample-accurate sync. Native still uses the
  // playbackRef Audio.Sound path because expo-av has no shared clock
  // with the Web Audio backing.
  const recordingSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const recordingGainRef = useRef<GainNode | null>(null);
  // Raw decoded recording (kept around so a syncOffset nudge can rebuild
  // the aligned buffer without re-fetching/decoding).
  const recordingRawBufferRef = useRef<AudioBuffer | null>(null);
  const lastRecordingUriRef = useRef<string | null>(null);
  const countInRef = useRef<CountInHandle | null>(null);
  // Set true the moment the screen unmounts. Async paths that create
  // audio handles (phraseLoop, Audio.Sound) check this after their
  // awaits — if the user has already navigated away, dispose the
  // newly-created handle instead of stashing it. Without this guard,
  // a race between stopRecording's async startDonePlayback and a
  // back-navigation left the loop + sound running on a dead screen.
  const unmountedRef = useRef(false);
  const [countdown, setCountdown] = useState(0);

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

  const stopRecordingSource = useCallback(() => {
    const src = recordingSourceRef.current;
    recordingSourceRef.current = null;
    recordingGainRef.current = null;
    if (!src) return;
    try {
      src.stop();
    } catch {
      // already stopped / not started
    }
  }, []);

  const teardown = useCallback(() => {
    countInRef.current?.stop();
    countInRef.current = null;
    phraseLoopRef.current?.stop();
    phraseLoopRef.current = null;
    stopRecordingSource();
    recorderRef.current?.stop().catch(() => {});
    recorderRef.current = null;
    setMicStream(null);
  }, [stopRecordingSource]);

  // settingsRef mirrors the user's toggle/volume state. We can't read
  // state directly in startLoopFromZero — it's a useCallback whose
  // closure would otherwise capture stale values, so toggling during
  // preview wouldn't carry into the recording-stage loop. Refs
  // sidestep that without making the callback ref churn on every
  // setting change.
  const settingsRef = useRef({
    backingEnabled,
    backingVolume,
    leadVocalEnabled,
    yourTakeEnabled,
    syncOffsetMs,
  });
  useEffect(() => {
    settingsRef.current = {
      backingEnabled,
      backingVolume,
      leadVocalEnabled,
      yourTakeEnabled,
      syncOffsetMs,
    };
  }, [
    backingEnabled,
    backingVolume,
    leadVocalEnabled,
    yourTakeEnabled,
    syncOffsetMs,
  ]);

  const startLoopFromZero = useCallback(async () => {
    phraseLoopRef.current?.stop();
    phraseLoopRef.current = null;
    const s = settingsRef.current;
    const handle = await startPhraseLoop({
      backingUrl: phrase.backing_url,
      vocalsUrl: phrase.vocals_url,
      loopDurationSec: phrase.duration_ms / 1000,
      backingCacheKey: `${phrase.song_id}:${phrase.id}:backing`,
      vocalsCacheKey: `${phrase.song_id}:${phrase.id}:vocals`,
      backingEnabled: s.backingEnabled,
      backingVolume: s.backingVolume,
      vocalsEnabled: s.leadVocalEnabled,
      // No client-side leadInSec: the worker now bakes a real
      // vocal-free lead-in into the audio file (see slice.py
      // LEAD_IN_MS). Old songs processed before that change have
      // no lead-in — re-upload them to pick it up.
      onPositionMs: (ms) => {
        currentMsRef.current = ms;
      },
    });
    if (unmountedRef.current) {
      handle?.stop();
      return null;
    }
    if (!handle) {
      setErrorMsg('Audio not available on this device');
      setStage('error');
      return null;
    }
    phraseLoopRef.current = handle;
    // Re-sync to the LATEST settings in case the user toggled or
    // adjusted volume during startPhraseLoop's await window. The
    // toggle useEffects fire on state change, but if phraseLoopRef
    // was still null at that moment they no-op'd — so we re-apply
    // here once the handle exists.
    const latest = settingsRef.current;
    handle.setBackingEnabled(latest.backingEnabled);
    handle.setBackingVolume(latest.backingVolume);
    handle.setVocalsEnabled(latest.leadVocalEnabled);
    return handle;
  }, [phrase]);

  const startInitialLoop = useCallback(async () => {
    Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
    primeMicPermission().catch(() => {
      // Permission not granted yet — recorder.prepare() will surface
      // a friendly error if Record is pressed before access is allowed.
    });
    // Count-in on first arrival too, not just when Record is pressed.
    // The user wants a moment to settle into the tempo before the
    // phrase begins playing.
    setStage('countdown');
    setCountdown(4);
    const bpm = phrase.tempo_bpm ?? 120;
    countInRef.current = startCountIn({
      bpm,
      beats: 4,
      onBeat: (n) => setCountdown(5 - n),
      onComplete: async () => {
        countInRef.current = null;
        const handle = await startLoopFromZero();
        if (handle) setStage('playing');
      },
    });
  }, [phrase, startLoopFromZero]);

  useEffect(() => {
    unmountedRef.current = false;
    void startInitialLoop();
    return () => {
      unmountedRef.current = true;
      teardown();
      playbackRef.current?.unloadAsync().catch(() => {});
      playbackRef.current = null;
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
  // Your-take gain: ramped on the recording's GainNode in the same
  // 30ms window phraseLoop uses, so the toggle feels consistent.
  useEffect(() => {
    const gain = recordingGainRef.current;
    const ctx = getAudioContext();
    if (!gain || !ctx) return;
    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(yourTakeEnabled ? 1.0 : 0, t + 0.03);
  }, [yourTakeEnabled]);

  // Sync nudge: rebuild the aligned recording buffer with the new
  // offset and restart the take source at the current loop position.
  // Backing keeps playing — only the take is re-anchored. No-op if
  // we're not currently in done view (no source/buffer yet).
  useEffect(() => {
    const ctx = getAudioContext();
    const raw = recordingRawBufferRef.current;
    const phraseLoop = phraseLoopRef.current;
    const oldSrc = recordingSourceRef.current;
    const gain = recordingGainRef.current;
    if (!ctx || !raw || !phraseLoop || !gain) return;
    const aligned = buildAlignedRecording(
      ctx,
      raw,
      phrase.duration_ms / 1000,
      syncOffsetMs,
    );
    const positionMs = phraseLoop.getPositionMs();
    const positionSec = Math.max(
      0,
      Math.min(phrase.duration_ms / 1000, positionMs / 1000),
    );
    if (oldSrc) {
      try {
        oldSrc.stop();
      } catch {
        // already stopped
      }
    }
    const s = ctx.createBufferSource();
    s.buffer = aligned;
    s.loop = true;
    s.connect(gain);
    s.start(ctx.currentTime + 0.02, positionSec);
    recordingSourceRef.current = s;
  }, [syncOffsetMs, phrase.duration_ms]);

  // Start (or restart) playback of the just-recorded take alongside a
  // looping phrase backing track. On web both sources are scheduled at
  // the SAME ctx.currentTime so they're sample-accurately aligned —
  // backing/vocals + the user's recording all start together. The
  // earlier path used expo-av's Audio.Sound for the recording, which
  // ran on a separate clock from the Web Audio backing and drifted by
  // the duration of the createAsync await (50–500ms).
  const startDonePlayback = useCallback(async () => {
    playbackRef.current?.unloadAsync().catch(() => {});
    playbackRef.current = null;
    stopRecordingSource();
    phraseLoopRef.current?.stop();
    phraseLoopRef.current = null;

    const uri = lastRecordingUriRef.current;
    if (!uri) return;

    const ctx = getAudioContext();
    // Decode the recording in parallel with the phrase buffers so we
    // can schedule both at one ctx.currentTime anchor. Web only —
    // native fetch+decodeAudioData isn't available, so it falls
    // through to the Audio.Sound path.
    let recordingBuffer: AudioBuffer | null = null;
    if (ctx) {
      try {
        const response = await fetch(uri);
        const arrayBuffer = await response.arrayBuffer();
        recordingBuffer = await ctx.decodeAudioData(arrayBuffer);
      } catch (e) {
        console.warn('[done] recording decode failed:', e);
      }
    }
    if (unmountedRef.current) return;

    // Common future timestamp for everything that follows. 0.1s gives
    // startPhraseLoop (which itself awaits a buffer cache lookup) and
    // the source.start scheduling enough headroom to not miss the
    // window.
    const commonStartAt = ctx ? ctx.currentTime + 0.1 : 0;

    const s = settingsRef.current;
    const handle = await startPhraseLoop({
      backingUrl: phrase.backing_url,
      vocalsUrl: phrase.vocals_url,
      loopDurationSec: phrase.duration_ms / 1000,
      backingCacheKey: `${phrase.song_id}:${phrase.id}:backing`,
      vocalsCacheKey: `${phrase.song_id}:${phrase.id}:vocals`,
      backingEnabled: s.backingEnabled,
      backingVolume: s.backingVolume,
      vocalsEnabled: s.leadVocalEnabled,
      startAt: ctx ? commonStartAt : undefined,
      onPositionMs: (ms) => {
        currentMsRef.current = ms;
      },
    });
    if (unmountedRef.current) {
      handle?.stop();
      return;
    }
    if (handle) {
      phraseLoopRef.current = handle;
      const latest = settingsRef.current;
      handle.setBackingEnabled(latest.backingEnabled);
      handle.setBackingVolume(latest.backingVolume);
      handle.setVocalsEnabled(latest.leadVocalEnabled);
    }

    if (ctx && recordingBuffer) {
      // Stash raw buffer so the syncOffset nudge can rebuild without
      // re-fetching the recording.
      recordingRawBufferRef.current = recordingBuffer;
      const phraseSec = phrase.duration_ms / 1000;
      const aligned = buildAlignedRecording(
        ctx,
        recordingBuffer,
        phraseSec,
        settingsRef.current.syncOffsetMs,
      );
      const source = ctx.createBufferSource();
      source.buffer = aligned;
      source.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = settingsRef.current.yourTakeEnabled ? 1.0 : 0;
      source.connect(gain).connect(ctx.destination);
      source.start(commonStartAt);
      recordingSourceRef.current = source;
      recordingGainRef.current = gain;
    } else {
      // Native fallback: expo-av Audio.Sound. Drifts vs backing,
      // but native doesn't share the Web Audio clock anyway.
      const { sound } = await Audio.Sound.createAsync({ uri });
      if (unmountedRef.current) {
        sound.unloadAsync().catch(() => {});
        return;
      }
      playbackRef.current = sound;
      sound.playAsync().catch(() => {});
    }
  }, [phrase, stopRecordingSource]);

  const stopRecording = useCallback(async () => {
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

    phraseLoopRef.current?.stop();
    phraseLoopRef.current = null;
    currentMsRef.current = phrase.duration_ms;

    setStage('done');
    void startDonePlayback();

    try {
      const { attemptId } = await uploadAndInsert(phrase, uri);

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
  }, [phrase, startDonePlayback]);

  const startRecording = useCallback(async () => {
    if (!recorderRef.current) {
      recorderRef.current = createRecorder();
    }
    const recorder = recorderRef.current;

    try {
      await recorder.prepare();
    } catch (e) {
      console.warn('recorder prepare failed:', e);
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage('error');
      return;
    }

    // Pause the loop while we count in — the metronome clicks need the
    // foreground, and the loop will restart from t=0 right after.
    phraseLoopRef.current?.stop();
    phraseLoopRef.current = null;
    currentMsRef.current = 0;

    setStage('countdown');
    setCountdown(4);

    const bpm = phrase.tempo_bpm ?? 120;
    countInRef.current = startCountIn({
      bpm,
      beats: 4,
      onBeat: (n) => {
        // n is 1..4 — display as 4..3..2..1 so the user sees a
        // descending count.
        setCountdown(5 - n);
      },
      onComplete: async () => {
        countInRef.current = null;
        // Loop restarts from t=0 + recording starts simultaneously.
        // Pitch analysis can index against phrase notes directly.
        const handle = await startLoopFromZero();
        if (!handle) return;
        setStage('recording');
        recorder.start().catch((e) =>
          console.warn('recorder start failed:', e),
        );
        setMicStream(recorder.getStream());
      },
    });
  }, [phrase, startLoopFromZero]);

  const cancelCountIn = useCallback(() => {
    countInRef.current?.stop();
    countInRef.current = null;
    setCountdown(0);
    void (async () => {
      const handle = await startLoopFromZero();
      if (handle) setStage('playing');
    })();
  }, [startLoopFromZero]);

  // Replay tears down the existing playback + backing loop and starts
  // fresh, so backing + mic always start aligned at t=0 of the take.
  const replayTake = useCallback(async () => {
    await startDonePlayback();
  }, [startDonePlayback]);

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
    await startInitialLoop();
  }, [revokeLastRecording, startInitialLoop]);

  const loopRunning = stage === 'playing' || stage === 'recording';
  const showRibbon =
    loopRunning || stage === 'done' || stage === 'countdown';

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
        {stage === 'countdown' && (
          <View style={styles.liveControls}>
            <Text style={styles.countdownNum}>{countdown || ' '}</Text>
            <RetroButton label="Cancel" onPress={cancelCountIn} size="md" />
          </View>
        )}
        {(stage === 'playing' || stage === 'recording') && (
          <View style={styles.liveControls}>
            {stage === 'playing' && (
              <RetroButton
                label="● Record"
                onPress={startRecording}
                variant="danger"
                size="lg"
              />
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
            backingEnabled={backingEnabled}
            onToggleBacking={() => setBackingEnabled((v) => !v)}
            leadVocalEnabled={leadVocalEnabled}
            onToggleLeadVocal={() => setLeadVocalEnabled((v) => !v)}
            yourTakeEnabled={yourTakeEnabled}
            onToggleYourTake={() => setYourTakeEnabled((v) => !v)}
            backingVolume={backingVolume}
            onChangeBackingVolume={setBackingVolume}
            syncOffsetMs={syncOffsetMs}
            onChangeSyncOffset={setSyncOffsetMs}
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
    'countdown',
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
  backingEnabled,
  onToggleBacking,
  leadVocalEnabled,
  onToggleLeadVocal,
  yourTakeEnabled,
  onToggleYourTake,
  backingVolume,
  onChangeBackingVolume,
  syncOffsetMs,
  onChangeSyncOffset,
}: {
  analysis: PitchAnalysis | null;
  analysisPending: boolean;
  feedback: FeedbackResult | null;
  feedbackPending: boolean;
  onAgain: () => void;
  onReplay: () => void;
  backingEnabled: boolean;
  onToggleBacking: () => void;
  leadVocalEnabled: boolean;
  onToggleLeadVocal: () => void;
  yourTakeEnabled: boolean;
  onToggleYourTake: () => void;
  backingVolume: number;
  onChangeBackingVolume: (v: number) => void;
  syncOffsetMs: number;
  onChangeSyncOffset: (ms: number) => void;
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
      <View style={styles.toggleRow}>
        <ToggleChip
          label="Backing"
          enabled={backingEnabled}
          onToggle={onToggleBacking}
        />
        <ToggleChip
          label="Lead vocal"
          enabled={leadVocalEnabled}
          onToggle={onToggleLeadVocal}
        />
        <ToggleChip
          label="Your take"
          enabled={yourTakeEnabled}
          onToggle={onToggleYourTake}
        />
      </View>
      <BackingVolumeControl
        value={backingVolume}
        onChange={onChangeBackingVolume}
      />
      <SyncNudge value={syncOffsetMs} onChange={onChangeSyncOffset} />
      <View style={styles.controlRow}>
        <RetroButton label="Replay" icon="play" onPress={onReplay} size="md" />
        <RetroButton label="Again" onPress={onAgain} size="md" />
      </View>
    </View>
  );
}

function SyncNudge({
  value,
  onChange,
}: {
  value: number;
  onChange: (ms: number) => void;
}) {
  const sign = value > 0 ? '+' : '';
  return (
    <View style={styles.volumeRow}>
      <Text style={styles.volumeLabel}>SYNC</Text>
      <Pressable
        onPress={() =>
          onChange(Math.max(SYNC_OFFSET_MIN_MS, value - SYNC_OFFSET_STEP_MS))
        }
        style={({ pressed }) => [
          styles.volumeBtn,
          pressed && styles.volumeBtnPressed,
        ]}
        hitSlop={8}
      >
        <Text style={styles.volumeBtnLabel}>−</Text>
      </Pressable>
      <Text style={styles.volumePct}>
        {sign}
        {value}ms
      </Text>
      <Pressable
        onPress={() =>
          onChange(Math.min(SYNC_OFFSET_MAX_MS, value + SYNC_OFFSET_STEP_MS))
        }
        style={({ pressed }) => [
          styles.volumeBtn,
          pressed && styles.volumeBtnPressed,
        ]}
        hitSlop={8}
      >
        <Text style={styles.volumeBtnLabel}>+</Text>
      </Pressable>
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
  countdownNum: {
    fontFamily: FONTS.pixel,
    fontSize: 96,
    lineHeight: 96,
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
