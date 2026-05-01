import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import Chrome from '../components/Chrome';
import RetroButton from '../components/RetroButton';
import { listPhrases, listSections, type PhraseListRow } from '../lib/phrases';
import { getSong } from '../lib/songs';
import { BORDER_1BIT, COLORS, FONTS } from '../theme';
import type { Song } from '../types';

type Props = {
  songId: string;
  onPick: (phrase: PhraseListRow) => void;
  onBack: () => void;
};

const SECTION_DISPLAY: Record<string, string> = {
  intro: 'Intro',
  verse: 'Verse',
  chorus: 'Chorus',
  bridge: 'Bridge',
  outro: 'Outro',
};

/** Pretty-print a section phrase's label with its index, e.g. "Verse 2",
 *  "Chorus", "Intro". Bridges/intros/outros usually appear once; we still
 *  number them when they don't, so a song with two bridges shows
 *  "Bridge 1" / "Bridge 2" instead of two indistinguishable rows. */
function sectionTitle(p: PhraseListRow, totalForType: number): string {
  const base = SECTION_DISPLAY[p.phrase_type] ?? p.phrase_type;
  if (totalForType <= 1) return base;
  return `${base} ${p.section_index ?? ''}`.trim();
}

// Prefer structural sections (intro/verse/chorus/...); fall back to lines
// for songs too short for the section detector.
export default function PickerScreen({ songId, onPick, onBack }: Props) {
  const [song, setSong] = useState<Song | null>(null);
  const [phrases, setPhrases] = useState<PhraseListRow[] | null>(null);
  const [mode, setMode] = useState<'section' | 'line' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [wholeSong, setWholeSong] = useState<PhraseListRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhrases(null);
    setMode(null);
    setWholeSong(null);
    setError(null);
    (async () => {
      try {
        const [s, sections, wholeSongs] = await Promise.all([
          getSong(songId),
          listSections(songId),
          listPhrases(songId, 'whole_song'),
        ]);
        if (cancelled) return;
        setSong(s);
        setWholeSong(wholeSongs[0] ?? null);
        if (sections.length > 0) {
          setPhrases(sections);
          setMode('section');
          return;
        }
        // No sections → short or sparse song; fall back to per-line.
        const lines = await listPhrases(songId, 'line');
        if (cancelled) return;
        setPhrases(lines);
        setMode(lines.length > 0 ? 'line' : null);
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

  // Tally how many phrases share each section label so we know whether to
  // show "Verse 2" vs just "Verse". Memoize on the phrases array.
  const typeCounts: Record<string, number> = {};
  if (phrases) {
    for (const p of phrases) {
      typeCounts[p.phrase_type] = (typeCounts[p.phrase_type] ?? 0) + 1;
    }
  }

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
            {wholeSong && (
              <>
                <Pressable
                  onPress={() => onPick(wholeSong)}
                  style={({ pressed }) => [
                    styles.wholeSongRow,
                    pressed && styles.rowPressed,
                  ]}
                >
                  <View style={styles.wholeSongIcon}>
                    <Text style={styles.wholeSongIconText}>★</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.wholeSongLabel}>ENTIRE SONG</Text>
                    <Text style={styles.rowMeta}>
                      {(wholeSong.duration_ms / 1000).toFixed(0)}s · sing the whole thing
                    </Text>
                  </View>
                  <Text style={styles.chevron}>▶</Text>
                </Pressable>
                <View style={styles.sep} />
                <Text style={styles.sectionLabel}>OR PRACTICE A PIECE</Text>
              </>
            )}
            {mode === 'line' && (
              <Text style={styles.modeNote}>
                This song is short — showing individual lines.
              </Text>
            )}
            <FlatList
              data={phrases}
              keyExtractor={(p) => p.id}
              ItemSeparatorComponent={() => <View style={styles.sep} />}
              renderItem={({ item, index }) => (
                <PhraseRow
                  phrase={item}
                  index={index}
                  onPick={onPick}
                  mode={mode}
                  totalForType={typeCounts[item.phrase_type] ?? 0}
                />
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
  mode,
  totalForType,
}: {
  phrase: PhraseListRow;
  index: number;
  onPick: (p: PhraseListRow) => void;
  mode: 'section' | 'line' | null;
  totalForType: number;
}) {
  const dur = (phrase.duration_ms / 1000).toFixed(1);
  const isSection = mode === 'section';
  const title = isSection ? sectionTitle(phrase, totalForType) : null;
  return (
    <Pressable
      onPress={() => onPick(phrase)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {isSection ? (
        <View style={styles.sectionBadge}>
          <Text style={styles.sectionBadgeText}>{title}</Text>
        </View>
      ) : (
        <View style={styles.idxBubble}>
          <Text style={styles.idxText}>{index + 1}</Text>
        </View>
      )}
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
  wholeSongRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 10,
    backgroundColor: COLORS.black,
    marginBottom: 12,
    ...BORDER_1BIT,
  },
  wholeSongIcon: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
    ...BORDER_1BIT,
  },
  wholeSongIconText: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 16,
    color: COLORS.black,
  },
  wholeSongLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 14,
    letterSpacing: 1,
    color: COLORS.white,
  },
  sectionLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 10,
    letterSpacing: 2,
    color: COLORS.softGrey,
    marginTop: 8,
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
  sectionBadge: {
    minWidth: 64,
    paddingHorizontal: 8,
    paddingVertical: 4,
    ...BORDER_1BIT,
    backgroundColor: COLORS.black,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionBadgeText: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: 1,
    color: COLORS.white,
    textAlign: 'center',
  },
  rowLyric: { fontFamily: FONTS.chicago, fontWeight: '700', fontSize: 14, letterSpacing: -0.2 },
  rowMeta: { fontFamily: FONTS.monaco, fontSize: 11, color: COLORS.softGrey, marginTop: 2 },
  chevron: { fontFamily: FONTS.chicago, fontSize: 18 },
  sep: { height: 1, backgroundColor: COLORS.grey, marginHorizontal: -20 },
});
