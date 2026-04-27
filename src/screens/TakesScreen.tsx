import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Chrome from '../components/Chrome';
import RetroButton from '../components/RetroButton';
import { listAttempts, signTakeUrls, type TakeRow } from '../lib/attempts';
import { startTakePlayback, type TakePlaybackHandle } from '../lib/takePlayback';
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
    handleRef.current?.stop();
    handleRef.current = null;
    setActiveHandle(null);
    setActiveId(null);
  }, []);

  const playTake = useCallback(
    async (take: TakeRow) => {
      stopActive();
      try {
        const { recordingUrl, vocalsUrl, backingUrl } = await signTakeUrls(take);
        const handle = await startTakePlayback({
          recordingUrl,
          vocalsUrl,
          backingUrl,
          loopDurationSec: take.phrase.duration_ms / 1000,
          songId: take.phrase.song_id,
          phraseId: take.phrase.id,
        });
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
    [stopActive],
  );

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
}: {
  take: TakeRow;
  isActive: boolean;
  handle: TakePlaybackHandle | null;
  onPlay: () => void;
  onStop: () => void;
}) {
  // Toggle states are local to a row that's actively playing — they
  // stay in sync with the live handle's gains via the setter calls.
  const [backing, setBacking] = useState(true);
  const [vocals, setVocals] = useState(true);
  const [take_, setTake] = useState(true);

  useEffect(() => {
    if (!isActive) {
      setBacking(true);
      setVocals(true);
      setTake(true);
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
      </View>
      {isActive && (
        <View style={styles.toggleRow}>
          <ToggleChip
            label="Backing"
            enabled={backing}
            onToggle={() => setBacking((v) => !v)}
          />
          <ToggleChip
            label="Lead vocal"
            enabled={vocals}
            onToggle={() => setVocals((v) => !v)}
          />
          <ToggleChip
            label="Your take"
            enabled={take_}
            onToggle={() => setTake((v) => !v)}
          />
        </View>
      )}
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
