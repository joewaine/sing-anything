import * as DocumentPicker from 'expo-document-picker';
import { ensureSignedIn } from './auth';
import { deleteSong, insertSong } from './songs';
import { requireSupabase } from './supabase';

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30 MB — matches worker-side cap

const WORKER_URL = process.env.EXPO_PUBLIC_WORKER_URL;

export type PickedFile = {
  uri: string;
  name: string;
  mimeType: string | null;
  size: number;
};

export async function pickAudio(): Promise<PickedFile | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: 'audio/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled || !res.assets?.length) return null;
  const asset = res.assets[0];
  return {
    uri: asset.uri,
    name: asset.name,
    mimeType: asset.mimeType ?? null,
    size: asset.size ?? 0,
  };
}

function slugify(s: string): string {
  return (s || 'song')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'song';
}

function extFromName(name: string, mimeType: string | null): string {
  const m = name.match(/\.([a-zA-Z0-9]+)$/);
  if (m) return m[1].toLowerCase();
  if (mimeType?.includes('mpeg')) return 'mp3';
  if (mimeType?.includes('wav')) return 'wav';
  if (mimeType?.includes('ogg')) return 'ogg';
  if (mimeType?.includes('flac')) return 'flac';
  return 'mp3';
}

function genId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // RFC 4122 v4 fallback
  const rnd = () => Math.floor(Math.random() * 16).toString(16);
  const s: string[] = [];
  for (let i = 0; i < 32; i++) s.push(rnd());
  s[12] = '4';
  s[16] = ((parseInt(s[16], 16) & 0x3) | 0x8).toString(16);
  return `${s.slice(0, 8).join('')}-${s.slice(8, 12).join('')}-${s.slice(12, 16).join('')}-${s.slice(16, 20).join('')}-${s.slice(20).join('')}`;
}

export type UploadResult = {
  song_id: string;
  job_id: string;
};

export type UploadProgressEvent =
  | { stage: 'reading' }
  | { stage: 'uploading' }
  | { stage: 'enqueuing' }
  | { stage: 'done'; song_id: string; job_id: string };

/**
 * Pick → upload to Storage → insert song → POST to Modal → return { song_id, job_id }.
 * Caller subscribes to the jobs table for progress.
 */
export async function uploadSong(
  file: PickedFile,
  onProgress?: (e: UploadProgressEvent) => void,
): Promise<UploadResult> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; max is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    );
  }
  if (!WORKER_URL) {
    throw new Error('EXPO_PUBLIC_WORKER_URL is unset — deploy the Modal worker first.');
  }

  const session = await ensureSignedIn();
  if (!session) throw new Error('Not signed in');
  const userId = session.user.id;
  const accessToken = session.access_token;

  onProgress?.({ stage: 'reading' });
  const resp = await fetch(file.uri);
  const blob = await resp.blob();

  const songId = genId();
  const ext = extFromName(file.name, file.mimeType);
  const storagePath = `${userId}/${songId}.${ext}`;

  onProgress?.({ stage: 'uploading' });
  const supabase = requireSupabase();
  const { error: uploadErr } = await supabase.storage
    .from('originals')
    .upload(storagePath, blob, {
      contentType: file.mimeType ?? 'audio/mpeg',
      upsert: false,
    });
  if (uploadErr) throw uploadErr;

  const slug = `${slugify(file.name)}-${songId.slice(0, 8)}`;
  await insertSong({
    id: songId,
    user_id: userId,
    slug,
    name: file.name.replace(/\.[a-z0-9]+$/i, ''),
    artist: null,
    original_path: storagePath,
  });

  onProgress?.({ stage: 'enqueuing' });
  let workerResp: Response;
  try {
    workerResp = await fetch(`${WORKER_URL.replace(/\/+$/, '')}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ song_id: songId }),
    });
  } catch (e) {
    // Network failure between Storage upload and Modal — clean up the
    // orphan row so it doesn't sit in the library forever.
    await deleteSong(songId).catch(() => undefined);
    throw e;
  }
  if (!workerResp.ok) {
    const err = await workerError(workerResp, 'upload');
    await deleteSong(songId).catch(() => undefined);
    throw err;
  }
  const { job_id: jobId } = (await workerResp.json()) as { job_id: string };

  onProgress?.({ stage: 'done', song_id: songId, job_id: jobId });
  return { song_id: songId, job_id: jobId };
}

/** Re-run the pipeline on a song that errored out. The worker's idempotency
 *  check already permits this — when all prior jobs for the song are in
 *  terminal stages (done/error), it inserts a fresh job. We optimistically
 *  flip songs.status → queued so the Library row reflects the retry instantly
 *  instead of waiting for the worker's first stage() write. */
export async function retryProcessing(songId: string): Promise<{ job_id: string }> {
  if (!WORKER_URL) {
    throw new Error('EXPO_PUBLIC_WORKER_URL is unset — deploy the Modal worker first.');
  }
  const session = await ensureSignedIn();
  if (!session) throw new Error('Not signed in');

  const supabase = requireSupabase();
  const { error: updateErr } = await supabase
    .from('songs')
    .update({ status: 'queued', error: null })
    .eq('id', songId);
  if (updateErr) throw updateErr;

  const resp = await fetch(`${WORKER_URL.replace(/\/+$/, '')}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ song_id: songId }),
  });
  if (!resp.ok) {
    throw await workerError(resp, 'upload');
  }
  return (await resp.json()) as { job_id: string };
}

/** Friendlier error messages for worker non-2xx responses. 429 (quota) gets
 *  the server's detail surfaced verbatim because it's already user-facing;
 *  other codes stay generic so we don't leak internals. */
async function workerError(resp: Response, endpoint: string): Promise<Error> {
  let detail = '';
  try {
    const body = await resp.json();
    detail = typeof body?.detail === 'string' ? body.detail : '';
  } catch {
    try {
      detail = await resp.text();
    } catch {
      detail = '';
    }
  }
  if (resp.status === 429 && detail) return new Error(detail);
  if (resp.status === 401) return new Error('Sign-in expired. Refresh and try again.');
  if (resp.status === 404) return new Error('Song not found — try uploading again.');
  return new Error(`worker /${endpoint} ${resp.status}: ${detail || resp.statusText}`);
}

const URL_RE = /^https?:\/\/[^\s]+$/i;

/** True for any http(s) URL. The worker uses yt-dlp, which handles YouTube,
 *  SoundCloud, Vimeo, Bandcamp, direct audio files, and ~1000 other sites. */
export function isAudioUrl(s: string): boolean {
  return URL_RE.test(s.trim());
}

/** @deprecated — kept for back-compat with earlier UI copy. */
export function isYoutubeUrl(s: string): boolean {
  return isAudioUrl(s);
}

/**
 * Submit a YouTube URL for ingest. The client inserts a placeholder song row
 * (so Library reflects it immediately); the worker downloads via yt-dlp,
 * updates the row with real title/artist, mirrors the mp3 into the originals
 * bucket, and runs the normal pipeline.
 */
export async function uploadFromYoutube(
  youtubeUrl: string,
  onProgress?: (e: UploadProgressEvent) => void,
): Promise<UploadResult> {
  const trimmed = youtubeUrl.trim();
  if (!trimmed || !isAudioUrl(trimmed)) {
    throw new Error('Not a valid URL (needs to start with http:// or https://).');
  }
  if (!WORKER_URL) {
    throw new Error('EXPO_PUBLIC_WORKER_URL is unset — deploy the Modal worker first.');
  }

  const session = await ensureSignedIn();
  if (!session) throw new Error('Not signed in');
  const userId = session.user.id;
  const accessToken = session.access_token;

  const songId = genId();
  const originalPath = `${userId}/${songId}.mp3`;

  onProgress?.({ stage: 'enqueuing' });

  await insertSong({
    id: songId,
    user_id: userId,
    slug: `youtube-${songId.slice(0, 8)}`,
    name: 'Downloading from YouTube…',
    artist: null,
    original_path: originalPath,
  });

  let workerResp: Response;
  try {
    workerResp = await fetch(`${WORKER_URL.replace(/\/+$/, '')}/upload_youtube`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ song_id: songId, youtube_url: trimmed }),
    });
  } catch (e) {
    await deleteSong(songId).catch(() => undefined);
    throw e;
  }
  if (!workerResp.ok) {
    const err = await workerError(workerResp, 'upload_youtube');
    await deleteSong(songId).catch(() => undefined);
    throw err;
  }
  const { job_id: jobId } = (await workerResp.json()) as { job_id: string };

  onProgress?.({ stage: 'done', song_id: songId, job_id: jobId });
  return { song_id: songId, job_id: jobId };
}

