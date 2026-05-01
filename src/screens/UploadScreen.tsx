import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import Chrome from '../components/Chrome';
import RetroButton from '../components/RetroButton';
import { subscribeToJob } from '../lib/jobs';
import {
  isAudioUrl,
  pickAudio,
  uploadFromYoutube,
  uploadSong,
  type PickedFile,
  type UploadProgressEvent,
  type UploadResult,
} from '../lib/upload';
import { BORDER_1BIT, COLORS, FONTS } from '../theme';
import type { Job } from '../types';

type Props = {
  onBack: () => void;
  onReady: (songId: string) => void;
  onShowTerms?: () => void;
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; stage: 'reading' | 'uploading' | 'enqueuing' }
  | { kind: 'processing'; songId: string; jobId: string; job: Job | null }
  | { kind: 'ready'; songId: string }
  | { kind: 'error'; message: string };

// URL paste re-enabled — YouTube ingest works again now that the worker
// routes via IPRoyal residential proxy.
const URL_UPLOAD_ENABLED = true;

const STAGE_LABEL: Record<string, string> = {
  queued: 'Queued...',
  upload: 'Downloading original...',
  stemming: 'Separating vocals from backing...',
  whisper: 'Transcribing lyrics...',
  pitch: 'Tracking pitch...',
  slicing: 'Slicing phrases...',
  done: 'Ready!',
  error: 'Failed',
};

export default function UploadScreen({ onBack, onReady, onShowTerms }: Props) {
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [ytUrl, setYtUrl] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const unsubRef = useRef<(() => void) | null>(null);

  // Tear down any active Realtime subscription when the screen unmounts so
  // we don't hold a channel open after the user navigates away.
  useEffect(() => {
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, []);

  const reset = () => {
    unsubRef.current?.();
    unsubRef.current = null;
    setPicked(null);
    setYtUrl('');
    setPhase({ kind: 'idle' });
  };

  // Common post-submit path: wire Realtime to drive the processing phase,
  // flip to `ready` / `error` at terminal stages.
  const wireJob = ({ song_id, job_id }: UploadResult) => {
    const unsub = subscribeToJob(job_id, (job) => {
      setPhase((prev) =>
        prev.kind === 'processing' ? { ...prev, job } : prev,
      );
      if (job.stage === 'done') {
        unsub();
        setPhase({ kind: 'ready', songId: song_id });
      } else if (job.stage === 'error') {
        unsub();
        setPhase({ kind: 'error', message: job.message ?? 'processing failed' });
      }
    });
    unsubRef.current = unsub;
  };

  const handleProgress = (e: UploadProgressEvent) => {
    if (e.stage === 'done') {
      setPhase({ kind: 'processing', songId: e.song_id, jobId: e.job_id, job: null });
    } else {
      setPhase({ kind: 'uploading', stage: e.stage });
    }
  };

  const onPick = async () => {
    try {
      const f = await pickAudio();
      if (f) setPicked(f);
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const onUpload = async () => {
    if (!picked) return;
    try {
      const result = await uploadSong(picked, handleProgress);
      wireJob(result);
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const onSubmitYoutube = async () => {
    const url = ytUrl.trim();
    if (!url) return;
    if (!isAudioUrl(url)) {
      setPhase({ kind: 'error', message: 'Not a valid URL.' });
      return;
    }
    try {
      const result = await uploadFromYoutube(url, handleProgress);
      wireJob(result);
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Chrome title="Upload">
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Add a song</Text>
          <RetroButton label="Back" onPress={onBack} size="sm" />
        </View>

        <View style={styles.body}>
          {phase.kind === 'idle' && !picked && (
            <View style={styles.stateBlock}>
              <Text style={styles.emoji}>🎵</Text>
              <Text style={styles.stateTitle}>Add a song</Text>
              <Text style={styles.stateBody}>
                Up to 30 MB, up to 10 minutes.
              </Text>
              <View style={{ marginTop: 16 }}>
                <RetroButton label="Choose file..." onPress={onPick} size="lg" />
              </View>
              {URL_UPLOAD_ENABLED && (
                <>
                  <Text style={styles.orLabel}>— or —</Text>
                  <View style={styles.urlRow}>
                    <TextInput
                      value={ytUrl}
                      onChangeText={setYtUrl}
                      onSubmitEditing={onSubmitYoutube}
                      placeholder="Paste a URL (YouTube, SoundCloud, Bandcamp…)"
                      placeholderTextColor={COLORS.softGrey}
                      autoCapitalize="none"
                      autoCorrect={false}
                      returnKeyType="go"
                      style={styles.urlInput}
                    />
                    <RetroButton
                      label="Fetch"
                      onPress={onSubmitYoutube}
                      size="md"
                      variant="dark"
                      icon="play"
                    />
                  </View>
                </>
              )}
            </View>
          )}

          {phase.kind === 'idle' && picked && (
            <View style={styles.stateBlock}>
              <Text style={styles.emoji}>📄</Text>
              <Text style={styles.stateTitle} numberOfLines={2}>
                {picked.name}
              </Text>
              <Text style={styles.stateBody}>
                {(picked.size / 1024 / 1024).toFixed(1)} MB
              </Text>
              <View style={styles.buttonRow}>
                <RetroButton label="Change" onPress={() => setPicked(null)} size="md" />
                <RetroButton label="Upload" onPress={onUpload} size="md" icon="play" variant="dark" />
              </View>
            </View>
          )}

          {phase.kind === 'uploading' && (
            <View style={styles.stateBlock}>
              <ActivityIndicator color={COLORS.black} />
              <Text style={styles.stateTitle}>
                {phase.stage === 'reading' && 'Reading file…'}
                {phase.stage === 'uploading' && 'Uploading…'}
                {phase.stage === 'enqueuing' && 'Queuing job…'}
              </Text>
            </View>
          )}

          {phase.kind === 'processing' && (
            <View style={styles.stateBlock}>
              <ActivityIndicator color={COLORS.black} />
              <Text style={styles.stateTitle}>
                {STAGE_LABEL[phase.job?.stage ?? 'queued'] ?? 'Processing…'}
              </Text>
              {phase.job?.progress != null && (
                <ProgressBar value={Number(phase.job.progress)} />
              )}
              <Text style={styles.stateBody}>
                {phase.job?.message ?? 'This takes about 2 minutes for a typical song.'}
              </Text>
              <Text style={styles.stateHint}>
                You can close the app — it'll keep processing server-side.
              </Text>
            </View>
          )}

          {phase.kind === 'ready' && (
            <View style={styles.stateBlock}>
              <Text style={styles.emoji}>✅</Text>
              <Text style={styles.stateTitle}>Ready!</Text>
              <RetroButton
                label="Practice this song"
                onPress={() => onReady(phase.songId)}
                size="lg"
                icon="play"
                variant="dark"
              />
            </View>
          )}

          {phase.kind === 'error' && (
            <View style={styles.stateBlock}>
              <Text style={styles.errorTitle}>OOPS</Text>
              <Text style={styles.stateBody}>{phase.message}</Text>
              <View style={{ marginTop: 16 }}>
                <RetroButton label="Try again" onPress={reset} size="md" />
              </View>
            </View>
          )}
        </View>

        {onShowTerms && (
          <Text style={styles.footerLink} onPress={onShowTerms}>
            Terms & Conditions
          </Text>
        )}
      </View>
    </Chrome>
  );
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <View style={styles.barOuter}>
      <View style={[styles.barFill, { width: `${pct}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 24 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.black,
    marginBottom: 24,
  },
  title: { fontFamily: FONTS.chicago, fontWeight: '700', fontSize: 20, letterSpacing: -0.3 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stateBlock: { alignItems: 'center', gap: 10, paddingHorizontal: 8, maxWidth: 380 },
  emoji: { fontSize: 48 },
  stateTitle: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 18,
    textAlign: 'center',
  },
  stateBody: {
    fontFamily: FONTS.monaco,
    fontSize: 12,
    color: COLORS.black,
    textAlign: 'center',
    lineHeight: 17,
    maxWidth: 320,
  },
  stateHint: {
    fontFamily: FONTS.monaco,
    fontSize: 10,
    color: COLORS.softGrey,
    textAlign: 'center',
    marginTop: 8,
    maxWidth: 320,
  },
  footerLink: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.softGrey,
    textAlign: 'center',
    textDecorationLine: 'underline',
    marginTop: 12,
  },
  orLabel: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.softGrey,
    marginTop: 20,
    marginBottom: 6,
  },
  urlRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    maxWidth: 420,
    width: '100%',
  },
  urlInput: {
    flex: 1,
    ...BORDER_1BIT,
    fontFamily: FONTS.monaco,
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: COLORS.white,
  },
  buttonRow: { flexDirection: 'row', gap: 12, marginTop: 16 },
  errorTitle: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 14,
    letterSpacing: 2,
    color: '#c00',
  },
  barOuter: {
    ...BORDER_1BIT,
    width: 240,
    height: 12,
    backgroundColor: COLORS.white,
    marginTop: 8,
  },
  barFill: { height: '100%', backgroundColor: COLORS.black },
});
