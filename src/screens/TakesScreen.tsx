import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Chrome from '../components/Chrome';
import RetroButton from '../components/RetroButton';
import {
  deleteAttempt,
  listAttempts,
  signTakeUrls,
  type TakeRow,
} from '../lib/attempts';
import { startTakePlayback, type TakePlaybackHandle } from '../lib/takePlayback';
import { useMixVolumes, type MixVolumes } from '../lib/mixVolumes';
import { BORDER_1BIT, COLORS, FONTS, SHADOW_1BIT } from '../theme';

type Props = {
  onBack: () => void;
};

export default function TakesScreen({ onBack }: Props) {
  const [takes, setTakes] = useState<TakeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeHandle, setActiveHandle] = useState<TakePlaybackHandle | null>(
    null,
  );
  const handleRef = useRef<TakePlaybackHandle | null>(null);
  const [mix, setMixKey] = useMixVolumes();
  // Generation counter for in-flight playTake calls. Each click bumps
  // the gen; if the awaits resolve under a stale gen the handle is
  // discarded. Without this, double-clicking Play (or quick switches
  // between rows) could leak two handles and play two tracks at once.
  const playGenRef = useRef(0);

  // Auto-detected offset from pitch analysis. No manual nudge in this
  // view (removed for now); takes view applies whatever the
  // detector found and that's it.
  const offsetForTake = useCallback((take: TakeRow | null): number => {
    const detected = take?.pitch_analysis?.detected_offset_ms;
    return typeof detected === 'number' && Number.isFinite(detected)
      ? detected
      : 0;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await listAttempts();
        if (!cancelled) setTakes(rows);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setTakes([]);
        }
      }
    })();
    return () => {
      cancelled = true;
      handleRef.current?.stop();
      handleRef.current = null;
    };
  }, []);

  const stopActive = useCallback(() => {
    // Bumping the generation invalidates any in-flight playTake call so
    // a late-resolving await won't stash a handle on a torn-down screen.
    playGenRef.current += 1;
    handleRef.current?.stop();
    handleRef.current = null;
    setActiveHandle(null);
    setActiveId(null);
  }, []);

  const playTake = useCallback(
    async (take: TakeRow) => {
      stopActive();
      const myGen = ++playGenRef.current;
      try {
        const { recordingUrl, vocalsUrl, backingUrl } = await signTakeUrls(take);
        if (myGen !== playGenRef.current) return;
        const handle = await startTakePlayback({
          recordingUrl,
          vocalsUrl,
          backingUrl,
          loopDurationSec: take.phrase.duration_ms / 1000,
          songId: take.phrase.song_id,
          phraseId: take.phrase.id,
          offsetMs: offsetForTake(take),
          // Default lead-vocal off in takes view — replaying a take is
          // about hearing yourself against the music, not against the
          // reference vocal. User can flip it on via the toggle.
          vocalsEnabled: false,
          // Apply persisted per-source volumes to the initial mix.
          backingVolume: mix.backing,
          vocalsVolume: mix.vocals,
          takeVolume: mix.take,
        });
        if (myGen !== playGenRef.current) {
          // Superseded by a later play / stop — discard this handle so
          // it doesn't keep playing in the background.
          handle?.stop();
          return;
        }
        if (!handle) {
          setError('Audio not available on this device');
          return;
        }
        handleRef.current = handle;
        setActiveHandle(handle);
        setActiveId(take.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [stopActive, offsetForTake, mix.backing, mix.vocals, mix.take],
  );

  const removeTake = useCallback(
    async (take: TakeRow) => {
      if (typeof window !== 'undefined' && window.confirm) {
        const ok = window.confirm('Delete this take? This cannot be undone.');
        if (!ok) return;
      }
      // If the row being deleted is currently playing, stop it.
      if (activeId === take.id) stopActive();
      try {
        await deleteAttempt(take);
        setTakes((prev) => (prev ? prev.filter((t) => t.id !== take.id) : prev));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [activeId, stopActive],
  );

  // Stop active playback when the tab is hidden (user switches tabs,
  // minimizes, or closes). pagehide also covers cases where the tab is
  // discarded without firing visibilitychange first.
  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        stopActive();
      }
    };
    const onPageHide = () => stopActive();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [stopActive]);

  return (
    <Chrome>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Your takes</Text>
          <RetroButton label="Back" onPress={onBack} size="sm" />
        </View>

        {takes === null ? (
          <View style={styles.center}>
            <ActivityIndicator color={COLORS.black} />
          </View>
        ) : takes.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyIcon}>🎙️</Text>
            <Text style={styles.emptyTitle}>No takes yet</Text>
            <Text style={styles.emptyBody}>
              Pick a song from your library and record a phrase. Your
              attempts will appear here.
            </Text>
            {error && <Text style={styles.errorText}>{error}</Text>}
          </View>
        ) : (
          <FlatList
            data={takes}
            keyExtractor={(t) => t.id}
            ItemSeparatorComponent={() => <View style={styles.sep} />}
            renderItem={({ item }) => (
              <TakeRowView
                take={item}
                isActive={item.id === activeId}
                handle={item.id === activeId ? activeHandle : null}
                onPlay={() => playTake(item)}
                onStop={stopActive}
                onDelete={() => removeTake(item)}
                mix={mix}
                onChangeMix={setMixKey}
              />
            )}
          />
        )}
      </View>
    </Chrome>
  );
}

function TakeRowView({
  take,
  isActive,
  handle,
  onPlay,
  onStop,
  onDelete,
  mix,
  onChangeMix,
}: {
  take: TakeRow;
  isActive: boolean;
  handle: TakePlaybackHandle | null;
  onPlay: () => void;
  onStop: () => void;
  onDelete: () => void;
  mix: MixVolumes;
  onChangeMix: (key: keyof MixVolumes, value: number) => void;
}) {
  // Toggle states are local to a row that's actively playing — they
  // stay in sync with the live handle's gains via the setter calls.
  const [backing, setBacking] = useState(true);
  // Default lead vocal OFF — replaying a take is about hearing
  // yourself against the music, not against the reference vocal.
  const [vocals, setVocals] = useState(false);
  const [take_, setTake] = useState(true);
  // Scrubber position. Updated from the playback handle's tick at
  // ~10Hz to keep state churn down; on drag we override locally and
  // call seek().
  const [positionMs, setPositionMs] = useState(0);
  const [draggingSeek, setDraggingSeek] = useState<number | null>(null);

  useEffect(() => {
    if (!isActive) {
      setBacking(true);
      setVocals(false);
      setTake(true);
      setPositionMs(0);
      setDraggingSeek(null);
    }
  }, [isActive]);

  useEffect(() => {
    handle?.setBackingEnabled(backing);
  }, [backing, handle]);
  useEffect(() => {
    handle?.setVocalsEnabled(vocals);
  }, [vocals, handle]);
  useEffect(() => {
    handle?.setTakeEnabled(take_);
  }, [take_, handle]);
  // Per-source volume — live updates to the playing handle as the
  // user drags a slider. The mix object itself is persisted by the
  // useMixVolumes hook in the parent.
  useEffect(() => {
    handle?.setBackingVolume(mix.backing);
  }, [mix.backing, handle]);
  useEffect(() => {
    handle?.setVocalsVolume(mix.vocals);
  }, [mix.vocals, handle]);
  useEffect(() => {
    handle?.setTakeVolume(mix.take);
  }, [mix.take, handle]);

  // Poll handle.getPositionMs at ~10Hz while active. Cheaper than
  // a 60Hz callback and the slider's eye doesn't notice the seam.
  useEffect(() => {
    if (!isActive || !handle) return;
    const id = setInterval(() => {
      if (draggingSeek === null) {
        setPositionMs(handle.getPositionMs());
      }
    }, 100);
    return () => clearInterval(id);
  }, [isActive, handle, draggingSeek]);

  const pa = take.pitch_analysis;
  const pct =
    pa && typeof pa.hit_rate === 'number'
      ? Math.round(pa.hit_rate * 100)
      : null;
  const date = new Date(take.created_at);
  const dateLabel = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const songName = take.phrase.song?.name ?? '—';
  const lyricSnippet =
    take.phrase.phrase_type === 'whole_song'
      ? '★ Entire song'
      : (take.phrase.lyric_text || '(instrumental)').slice(0, 80);

  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowSong} numberOfLines={1}>
            {songName.toUpperCase()}
          </Text>
          <Text style={styles.rowLyric} numberOfLines={2}>
            {lyricSnippet}
          </Text>
          <Text style={styles.rowMeta}>
            {dateLabel}
            {pct !== null ? ` · ${pct}% on pitch` : ''}
          </Text>
        </View>
        {isActive ? (
          <RetroButton label="■ Stop" onPress={onStop} variant="danger" size="md" />
        ) : (
          <RetroButton label="▶ Play" onPress={onPlay} size="md" />
        )}
        <Pressable
          onPress={onDelete}
          style={({ pressed }) => [
            styles.deleteBtn,
            pressed && styles.deleteBtnPressed,
          ]}
          hitSlop={6}
        >
          <Text style={styles.deleteBtnLabel}>×</Text>
        </Pressable>
      </View>
      {isActive && (
        <>
          <Scrubber
            positionMs={draggingSeek ?? positionMs}
            durationMs={take.phrase.duration_ms}
            onScrubStart={(ms) => setDraggingSeek(ms)}
            onScrubMove={(ms) => setDraggingSeek(ms)}
            onScrubEnd={(ms) => {
              setDraggingSeek(null);
              setPositionMs(ms);
              handle?.seek(ms);
            }}
          />
          <View style={styles.mixStack}>
            <MixRow
              label="Backing"
              enabled={backing}
              onToggle={() => setBacking((v) => !v)}
              volume={mix.backing}
              onChangeVolume={(v) => onChangeMix('backing', v)}
            />
            <MixRow
              label="Lead vocal"
              enabled={vocals}
              onToggle={() => setVocals((v) => !v)}
              volume={mix.vocals}
              onChangeVolume={(v) => onChangeMix('vocals', v)}
            />
            <MixRow
              label="Your take"
              enabled={take_}
              onToggle={() => setTake((v) => !v)}
              volume={mix.take}
              onChangeVolume={(v) => onChangeMix('take', v)}
            />
          </View>
        </>
      )}
    </View>
  );
}

function Scrubber({
  positionMs,
  durationMs,
  onScrubStart,
  onScrubMove,
  onScrubEnd,
}: {
  positionMs: number;
  durationMs: number;
  onScrubStart: (ms: number) => void;
  onScrubMove: (ms: number) => void;
  onScrubEnd: (ms: number) => void;
}) {
  // Web only — uses native <input type="range">. On native this is
  // a no-op; would need react-native-community/slider.
  if (Platform.OS !== 'web') return null;

  const fmt = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
  };

  const inputEl = createElement('input', {
    type: 'range',
    min: 0,
    max: Math.max(1, Math.round(durationMs)),
    step: 50,
    value: Math.round(positionMs),
    onMouseDown: (e: any) => onScrubStart(Number(e.target.value)),
    onTouchStart: (e: any) => onScrubStart(Number(e.target.value)),
    onChange: (e: any) => onScrubMove(Number(e.target.value)),
    onMouseUp: (e: any) => onScrubEnd(Number(e.target.value)),
    onTouchEnd: (e: any) => onScrubEnd(Number(e.target.value)),
    style: {
      width: '100%',
      accentColor: '#000',
      cursor: 'pointer',
    },
  });

  return (
    <View style={styles.scrubberRow}>
      <Text style={styles.scrubberTime}>{fmt(positionMs)}</Text>
      <View style={styles.scrubberFlex}>{inputEl}</View>
      <Text style={styles.scrubberTime}>{fmt(durationMs)}</Text>
    </View>
  );
}

function MixRow({
  label,
  enabled,
  onToggle,
  volume,
  onChangeVolume,
}: {
  label: string;
  enabled: boolean;
  onToggle: () => void;
  volume: number;
  onChangeVolume: (v: number) => void;
}) {
  const pct = Math.round(volume * 100);
  // Web range input — same approach as the scrubber. Native would
  // need a slider package; for now this row just renders the toggle
  // chip and percent without a slider on native.
  const slider =
    Platform.OS === 'web'
      ? createElement('input', {
          type: 'range',
          min: 0,
          max: 100,
          step: 1,
          value: pct,
          onChange: (e: any) =>
            onChangeVolume(Number(e.target.value) / 100),
          style: {
            width: '100%',
            accentColor: '#000',
            cursor: 'pointer',
          },
        })
      : null;
  return (
    <View style={styles.mixRow}>
      <View style={styles.mixChipWrap}>
        <ToggleChip label={label} enabled={enabled} onToggle={onToggle} />
      </View>
      <View style={styles.mixSliderWrap}>{slider}</View>
      <Text style={styles.mixPct}>{pct}%</Text>
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
        styles.chip,
        enabled && styles.chipOn,
        pressed && styles.chipPressed,
      ]}
      hitSlop={6}
    >
      <Text style={[styles.chipLabel, enabled && styles.chipLabelOn]}>
        {enabled ? '◉ ' : '○ '}
        {label}
      </Text>
    </Pressable>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { fontFamily: FONTS.chicago, fontWeight: '700', fontSize: 16 },
  emptyBody: {
    fontFamily: FONTS.monaco,
    fontSize: 12,
    color: COLORS.black,
    textAlign: 'center',
    lineHeight: 17,
    maxWidth: 320,
  },
  errorText: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: '#c00',
    marginTop: 8,
  },
  row: {
    paddingVertical: 10,
    paddingHorizontal: 4,
    gap: 8,
  },
  rowMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowSong: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: 1,
    color: COLORS.softGrey,
  },
  rowLyric: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 14,
    letterSpacing: -0.2,
    marginTop: 2,
  },
  rowMeta: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.softGrey,
    marginTop: 2,
  },
  sep: { height: 1, backgroundColor: COLORS.grey, marginHorizontal: -20 },
  toggleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  mixStack: {
    flexDirection: 'column',
    gap: 6,
    marginTop: 4,
  },
  mixRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  mixChipWrap: {
    width: 110,
  },
  mixSliderWrap: {
    flex: 1,
  },
  mixPct: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.black,
    minWidth: 36,
    textAlign: 'right',
  },
  scrubberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  scrubberFlex: { flex: 1 },
  scrubberTime: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.black,
    minWidth: 36,
    textAlign: 'center',
  },
  syncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 6,
  },
  syncLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 10,
    letterSpacing: 1,
    color: COLORS.black,
  },
  syncValue: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    minWidth: 64,
    textAlign: 'left',
    color: COLORS.black,
  },
  syncResetBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    ...BORDER_1BIT,
    backgroundColor: COLORS.white,
  },
  syncResetBtnPressed: {
    transform: [{ translateX: 1 }, { translateY: 1 }],
  },
  syncResetLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 9,
    letterSpacing: 1,
    color: COLORS.black,
  },
  syncHint: {
    fontFamily: FONTS.monaco,
    fontSize: 10,
    color: COLORS.softGrey,
    marginTop: 2,
  },
  deleteBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    ...BORDER_1BIT,
    backgroundColor: COLORS.white,
  },
  deleteBtnPressed: {
    transform: [{ translateX: 1 }, { translateY: 1 }],
    backgroundColor: '#ff3b30',
  },
  deleteBtnLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 18,
    color: COLORS.black,
    lineHeight: 18,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    ...BORDER_1BIT,
    backgroundColor: COLORS.white,
  },
  chipOn: {
    backgroundColor: COLORS.black,
    ...SHADOW_1BIT,
  },
  chipPressed: {
    transform: [{ translateX: 1 }, { translateY: 1 }],
  },
  chipLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: -0.2,
    color: COLORS.black,
  },
  chipLabelOn: { color: COLORS.white },
});
