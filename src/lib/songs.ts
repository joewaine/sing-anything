import { requireSupabase } from './supabase';
import type { Song } from '../types';

export async function listSongs(): Promise<Song[]> {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('songs')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Song[];
}

export async function getSong(id: string): Promise<Song> {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('songs')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data as Song;
}

export type DeleteSongResult = {
  storageErrors: string[];
};

/**
 * Fully remove a song: DB row (cascades phrases/jobs/attempts via FKs),
 * original mp3, all phrase slices, and all user-uploaded attempts audio.
 * Modal side has nothing song-specific to clean up.
 *
 * Storage cleanup is best-effort — any failures are returned as strings so
 * the caller can surface them, but the DB delete still goes through.
 */
export async function deleteSong(songId: string): Promise<DeleteSongResult> {
  const supabase = requireSupabase();
  const storageErrors: string[] = [];

  const { data: song, error: songErr } = await supabase
    .from('songs')
    .select('id, user_id, original_path')
    .eq('id', songId)
    .single();
  if (songErr || !song) throw new Error(`song lookup: ${songErr?.message ?? 'not found'}`);

  const { data: phraseRows } = await supabase
    .from('phrases')
    .select('id')
    .eq('song_id', songId);
  const phraseIds = (phraseRows ?? []).map((p) => p.id as string);

  let attemptPaths: string[] = [];
  if (phraseIds.length > 0) {
    const { data: attempts } = await supabase
      .from('attempts')
      .select('audio_path')
      .in('phrase_id', phraseIds);
    attemptPaths = (attempts ?? [])
      .map((a) => a.audio_path as string)
      .filter(Boolean);
  }

  // Discover phrase slices by listing the bucket — catches orphans from
  // mid-flight worker runs that haven't yet inserted DB rows. Paginate so
  // we don't silently skip slices past the default 100-row limit.
  const phrasePrefix = `${song.user_id}/${songId}`;
  const phrasePaths: string[] = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.storage
      .from('phrases')
      .list(phrasePrefix, {
        limit: PAGE,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
    if (error) {
      storageErrors.push(`phrases list: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    for (const f of data) phrasePaths.push(`${phrasePrefix}/${f.name}`);
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  const removeAll = async (bucket: string, paths: string[]) => {
    if (paths.length === 0) return;
    const { error } = await supabase.storage.from(bucket).remove(paths);
    if (error) storageErrors.push(`${bucket}: ${error.message}`);
  };

  await Promise.all([
    song.original_path ? removeAll('originals', [song.original_path]) : undefined,
    removeAll('phrases', phrasePaths),
    removeAll('attempts', attemptPaths),
  ]);

  const { error: deleteErr } = await supabase.from('songs').delete().eq('id', songId);
  if (deleteErr) throw new Error(`db delete: ${deleteErr.message}`);

  return { storageErrors };
}

type InsertSongArgs = {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  artist?: string | null;
  original_path: string;
};

export async function updateSongName(id: string, name: string): Promise<Song> {
  const supabase = requireSupabase();
  const trimmed = name.trim();
  if (!trimmed) throw new Error('name cannot be empty');
  const { data, error } = await supabase
    .from('songs')
    .update({ name: trimmed })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as Song;
}

export async function insertSong(args: InsertSongArgs): Promise<Song> {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('songs')
    .insert({
      id: args.id,
      user_id: args.user_id,
      slug: args.slug,
      name: args.name,
      artist: args.artist ?? null,
      original_path: args.original_path,
      status: 'queued',
    })
    .select()
    .single();
  if (error) throw error;
  return data as Song;
}
