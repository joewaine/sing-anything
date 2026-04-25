import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import Chrome from '../components/Chrome';
import RetroButton from '../components/RetroButton';
import { listPhrases, type PhraseListRow } from '../lib/phrases';
import { getSong } from '../lib/songs';
import { BORDER_1BIT, COLORS, FONTS } from '../theme';
import type { Song } from '../types';

type Props = {
  songId: string;
  onPick: (phrase: PhraseListRow) => void;
  onBack: () => void;
};

// Prefer verses; fall back to lines for short / sparse songs that didn't
// emit any verse groupings.
export default function PickerScreen({ songId, onPick, onBack }: Props) {
  const [song, setSong] = useState<Song | null>(null);
  const [phrases, setPhrases] = useState<PhraseListRow[] | null>(null);
  const [phraseType, setPhraseType] = useState<'verse' | 'line' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhrases(null);
    setPhraseType(null);
    setError(null);
    (async () => {
      try {
        const [s, verses] = await Promise.all([
          getSong(songId),
          listPhrases(songId, 'verse'),
        ]);
        if (cancelled) return;
        setSong(s);
        if (verses.length > 0) {
          setPhrases(verses);
          setPhraseType('verse');
          return;
        }
        // No verses → song is short or sparse; show its individual lines
        // instead of an empty state.
        const lines = await listPhrases(songId, 'line');
        if (cancelled) return;
        setPhrases(lines);
        setPhraseType(lines.length > 0 ? 'line' : null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhrases([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [songId]);

  return (
    <Chrome title={song?.name ?? 'Pick a phrase'}>
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={1}>
              {song?.name ?? '…'}
            </Text>
            {song?.artist && (
              <Text style={styles.subtitle} numberOfLines={1}>{song.artist}</Text>
            )}
          </View>
          <RetroButton label="Back" onPress={onBack} size="sm" />
        </View>

        {phrases === null ? (
          <View style={styles.center}>
            <ActivityIndicator color={COLORS.black} />
          </View>
        ) : phrases.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyIcon}>🎶</Text>
            <Text style={styles.emptyTitle}>No phrases yet</Text>
            <Text style={styles.emptyBody}>
              The pipeline didn't find any singable phrases. This usually means
              vocals were too quiet or the track was instrumental.
            </Text>
            {error && <Text style={styles.errorText}>{error}</Text>}
          </View>
        ) : (
          <>
            {phraseType === 'line' && (
              <Text style={styles.modeNote}>
                This song is short — showing individual lines.
              </Text>
            )}
            <FlatList
              data={phrases}
              keyExtractor={(p) => p.id}
              ItemSeparatorComponent={() => <View style={styles.sep} />}
              renderItem={({ item, index }) => (
                <PhraseRow phrase={item} index={index} onPick={onPick} />
              )}
            />
          </>
        )}
      </View>
    </Chrome>
  );
}

function PhraseRow({
  phrase,
  index,
  onPick,
}: {
  phrase: PhraseListRow;
  index: number;
  onPick: (p: PhraseListRow) => void;
}) {
  const dur = (phrase.duration_ms / 1000).toFixed(1);
  return (
    <Pressable
      onPress={() => onPick(phrase)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.idxBubble}>
        <Text style={styles.idxText}>{index + 1}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLyric} numberOfLines={2}>
          {phrase.lyric_text || '(instrumental)'}
        </Text>
        <Text style={styles.rowMeta}>{dur}s</Text>
      </View>
      <Text style={styles.chevron}>▶</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 24 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.black,
    marginBottom: 12,
    gap: 10,
  },
  title: { fontFamily: FONTS.chicago, fontWeight: '700', fontSize: 20, letterSpacing: -0.3 },
  subtitle: { fontFamily: FONTS.monaco, fontSize: 12, color: COLORS.softGrey, marginTop: 2 },
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
  errorText: { fontFamily: FONTS.monaco, fontSize: 11, color: '#c00', marginTop: 8 },
  modeNote: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.softGrey,
    marginBottom: 8,
    paddingHorizontal: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 6,
    gap: 12,
  },
  rowPressed: { backgroundColor: COLORS.lightGrey },
  idxBubble: {
    width: 26,
    height: 26,
    ...BORDER_1BIT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  idxText: { fontFamily: FONTS.chicago, fontWeight: '700', fontSize: 12 },
  rowLyric: { fontFamily: FONTS.chicago, fontWeight: '700', fontSize: 14, letterSpacing: -0.2 },
  rowMeta: { fontFamily: FONTS.monaco, fontSize: 11, color: COLORS.softGrey, marginTop: 2 },
  chevron: { fontFamily: FONTS.chicago, fontSize: 18 },
  sep: { height: 1, backgroundColor: COLORS.grey, marginHorizontal: -20 },
});
