import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Chrome from '../components/Chrome';
import RetroButton from '../components/RetroButton';
import { deleteSong, listSongs, updateSongName } from '../lib/songs';
import { hasSupabaseConfig, requireSupabase } from '../lib/supabase';
import { BORDER_1BIT, COLORS, FONTS } from '../theme';
import type { Song } from '../types';

type Props = {
  onUpload: () => void;
  onPickSong: (song: Song) => void;
  onYourTakes?: () => void;
  onCalibrate?: () => void;
  onBack?: () => void;
  onSignOut?: () => void;
};

const STATUS_LABEL: Record<Song['status'], string> = {
  queued: 'Queued',
  stemming: 'Splitting stems',
  analyzing: 'Analyzing',
  ready: 'Ready',
  error: 'Error',
};

export default function LibraryScreen({ onUpload, onPickSong, onYourTakes, onCalibrate, onBack, onSignOut }: Props) {
  const [songs, setSongs] = useState<Song[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = async () => {
    if (!hasSupabaseConfig) {
      setSongs([]);
      return;
    }
    try {
      setError(null);
      const rows = await listSongs();
      setSongs(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSongs([]);
    }
  };

  useEffect(() => {
    void refresh();
    if (!hasSupabaseConfig) return;

    // Realtime subscription on this user's songs. Apply each event as an
    // in-place delta against the current list — much cheaper than a full
    // re-fetch round trip per event (a single processing song fires 5-15
    // updates in 60-90s). One catch-up `refresh()` ran on subscribe.
    let unsub: (() => void) | null = null;
    (async () => {
      const supabase = requireSupabase();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const channel = supabase
        .channel('library-songs')
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'songs',
            filter: `user_id=eq.${user.id}`,
          },
          (payload) => {
            const row = payload.new as Song;
            setSongs((prev) => {
              if (!prev) return prev;
              if (prev.some((s) => s.id === row.id)) return prev;
              return [row, ...prev];
            });
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'songs',
            filter: `user_id=eq.${user.id}`,
          },
          (payload) => {
            const row = payload.new as Song;
            setSongs((prev) =>
              prev ? prev.map((s) => (s.id === row.id ? { ...s, ...row } : s)) : prev,
            );
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'DELETE',
            schema: 'public',
            table: 'songs',
            filter: `user_id=eq.${user.id}`,
          },
          (payload) => {
            const id = (payload.old as { id?: string }).id;
            if (!id) return;
            setSongs((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
          },
        )
        .subscribe();
      unsub = () => {
        void supabase.removeChannel(channel);
      };
    })();

    return () => {
      unsub?.();
    };
  }, []);

  const applyRename = (id: string, name: string) => {
    setSongs((prev) => (prev ? prev.map((s) => (s.id === id ? { ...s, name } : s)) : prev));
  };

  const applyDelete = (id: string) => {
    setSongs((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
  };

  return (
    <Chrome>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Your library</Text>
          <View style={styles.headerActions}>
            {onSignOut && <RetroButton label="Sign out" onPress={onSignOut} size="sm" />}
            {onYourTakes && (
              <RetroButton label="Your takes" onPress={onYourTakes} size="sm" />
            )}
            <RetroButton label="+ Upload" onPress={onUpload} size="sm" variant="dark" />
          </View>
        </View>

        {songs === null ? (
          <View style={styles.center}>
            <ActivityIndicator color={COLORS.black} />
          </View>
        ) : songs.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📼</Text>
            <Text style={styles.emptyTitle}>No songs yet</Text>
            <Text style={styles.emptyBody}>
              Upload a track you own or have rights to practice with. We'll separate
              the vocals, find the phrases, and get out of your way.
            </Text>
            <View style={{ marginTop: 16 }}>
              <RetroButton label="Upload a song" onPress={onUpload} size="lg" icon="play" variant="dark" />
            </View>
            {error && <Text style={styles.errorText}>{error}</Text>}
          </View>
        ) : (
          <FlatList
            data={songs}
            keyExtractor={(s) => s.id}
            ItemSeparatorComponent={() => <View style={styles.sep} />}
            renderItem={({ item }) => (
              <SongRow
                song={item}
                editing={editingId === item.id}
                onStartEdit={() => setEditingId(item.id)}
                onStopEdit={() => setEditingId(null)}
                onRenamed={(name) => applyRename(item.id, name)}
                onDeleted={() => applyDelete(item.id)}
                onPlay={onPickSong}
              />
            )}
          />
        )}
      </View>
    </Chrome>
  );
}

type RowProps = {
  song: Song;
  editing: boolean;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onRenamed: (name: string) => void;
  onDeleted: () => void;
  onPlay: (s: Song) => void;
};

function SongRow({
  song,
  editing,
  onStartEdit,
  onStopEdit,
  onRenamed,
  onDeleted,
  onPlay,
}: RowProps) {
  const isReady = song.status === 'ready';
  const isError = song.status === 'error';
  const [draft, setDraft] = useState(song.name);
  const [saving, setSaving] = useState(false);
  const [rowErr, setRowErr] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const doDelete = async () => {
    try {
      setDeleting(true);
      setRowErr(null);
      const res = await deleteSong(song.id);
      if (res.storageErrors.length > 0) {
        console.warn('delete: storage cleanup partial:', res.storageErrors);
      }
      onDeleted();
    } catch (e) {
      setRowErr(e instanceof Error ? e.message : String(e));
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  useEffect(() => {
    if (editing) {
      setDraft(song.name);
      setRowErr(null);
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [editing, song.name]);

  const save = async () => {
    const next = draft.trim();
    if (!next || next === song.name) {
      onStopEdit();
      return;
    }
    try {
      setSaving(true);
      await updateSongName(song.id, next);
      onRenamed(next);
      onStopEdit();
    } catch (e) {
      setRowErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setDraft(song.name);
    setRowErr(null);
    onStopEdit();
  };

  if (editing) {
    return (
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <TextInput
            ref={inputRef}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={save}
            editable={!saving}
            returnKeyType="done"
            style={styles.input}
            placeholder="Song title"
            placeholderTextColor={COLORS.softGrey}
          />
          {rowErr && <Text style={styles.rowError}>{rowErr}</Text>}
        </View>
        <View style={styles.editActions}>
          <RetroButton label={saving ? '...' : 'Save'} onPress={save} size="sm" variant="dark" />
          <RetroButton label="Cancel" onPress={cancel} size="sm" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Pressable
          onPress={onStartEdit}
          style={({ pressed }) => (pressed ? styles.titlePressed : null)}
        >
          <Text style={styles.rowName} numberOfLines={1}>
            {song.name}
          </Text>
        </Pressable>
        {/* Artist subtitle intentionally hidden in the library list — title alone is the read-target. */}
        <Text style={[styles.rowStatus, isError && styles.rowStatusError]}>
          {STATUS_LABEL[song.status] ?? song.status}
          {isError && song.error ? ` — ${song.error}` : ''}
        </Text>
        {rowErr && <Text style={styles.rowError}>{rowErr}</Text>}
      </View>
      <View style={styles.rowActions}>
        {isReady && !confirmingDelete && (
          <Pressable
            onPress={() => onPlay(song)}
            style={({ pressed }) => [styles.playBtn, pressed && styles.playBtnPressed]}
          >
            <Text style={styles.chevron}>▶</Text>
          </Pressable>
        )}
        {confirmingDelete ? (
          <View style={styles.confirmRow}>
            <Pressable
              onPress={doDelete}
              disabled={deleting}
              style={({ pressed }) => [styles.confirmBtn, pressed && styles.confirmBtnPressed]}
            >
              <Text style={styles.confirmBtnLabel}>
                {deleting ? '...' : 'Delete'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setConfirmingDelete(false)}
              disabled={deleting}
              style={({ pressed }) => [styles.cancelBtn, pressed && styles.cancelBtnPressed]}
            >
              <Text style={styles.cancelBtnLabel}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => setConfirmingDelete(true)}
            style={({ pressed }) => [styles.deleteBtn, pressed && styles.deleteBtnPressed]}
            hitSlop={6}
          >
            <Text style={styles.deleteX}>×</Text>
          </Pressable>
        )}
      </View>
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
    marginBottom: 16,
  },
  headerActions: { flexDirection: 'row', gap: 8 },
  title: { fontFamily: FONTS.chicago, fontWeight: '700', fontSize: 20, letterSpacing: -0.3 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 8 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontFamily: FONTS.chicago, fontWeight: '700', fontSize: 18 },
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
    marginTop: 12,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 10,
    gap: 10,
  },
  rowName: { fontFamily: FONTS.chicago, fontWeight: '700', fontSize: 15 },
  rowArtist: { fontFamily: FONTS.monaco, fontSize: 11, color: COLORS.softGrey, marginTop: 2 },
  rowStatus: { fontFamily: FONTS.monaco, fontSize: 11, color: COLORS.black, marginTop: 4 },
  rowStatusError: { color: '#c00' },
  titlePressed: { opacity: 0.55 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  playBtn: {
    width: 36,
    height: 36,
    ...BORDER_1BIT,
    backgroundColor: COLORS.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtnPressed: { backgroundColor: COLORS.black, transform: [{ translateX: 1 }, { translateY: 1 }] },
  chevron: { fontFamily: FONTS.chicago, fontSize: 14 },
  deleteBtn: {
    width: 28,
    height: 28,
    ...BORDER_1BIT,
    backgroundColor: COLORS.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtnPressed: {
    backgroundColor: '#ff3b30',
    transform: [{ translateX: 1 }, { translateY: 1 }],
  },
  deleteX: { fontFamily: FONTS.chicago, fontSize: 16, fontWeight: '700' },
  confirmRow: { flexDirection: 'row', gap: 4 },
  confirmBtn: {
    ...BORDER_1BIT,
    backgroundColor: '#ff3b30',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  confirmBtnPressed: { transform: [{ translateX: 1 }, { translateY: 1 }] },
  confirmBtnLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 12,
    color: COLORS.white,
    letterSpacing: -0.2,
  },
  cancelBtn: {
    ...BORDER_1BIT,
    backgroundColor: COLORS.white,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  cancelBtnPressed: {
    backgroundColor: COLORS.black,
    transform: [{ translateX: 1 }, { translateY: 1 }],
  },
  cancelBtnLabel: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 12,
    color: COLORS.black,
    letterSpacing: -0.2,
  },
  input: {
    ...BORDER_1BIT,
    fontFamily: FONTS.chicago,
    fontSize: 15,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: COLORS.white,
  },
  editActions: { flexDirection: 'row', gap: 6 },
  rowError: { fontFamily: FONTS.monaco, fontSize: 10, color: '#c00', marginTop: 4 },
  sep: { height: 1, backgroundColor: COLORS.grey, marginHorizontal: -20 },
});
