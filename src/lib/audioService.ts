// One long-lived AudioContext + a decoded-buffer cache keyed by URL.
// - Safari caps per-page AudioContexts at ~4–6; we never new/close per session.
// - Every repeat attempt was paying fetch+decode cost on the count-in critical
//   path; caching by URL removes that round-trip on retakes.
// - Cache is bounded (LRU(64)) so a long practice session doesn't accumulate
//   duplicates as signed URLs roll their TTL.

type AudioCtor = typeof AudioContext;

let sharedCtx: AudioContext | null = null;
const BUFFER_CACHE_MAX = 64;
// Map iteration order = insertion order, so re-inserting on a hit gives us
// LRU-ish behavior with no extra bookkeeping.
const bufferCache = new Map<string, Promise<AudioBuffer>>();

function pickCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioCtor;
    webkitAudioContext?: AudioCtor;
  };
  return w.AudioContext || w.webkitAudioContext || null;
}

export function getAudioContext(): AudioContext | null {
  if (sharedCtx) {
    if (sharedCtx.state === 'suspended') {
      sharedCtx.resume().catch(() => {});
    }
    return sharedCtx;
  }
  const Ctor = pickCtor();
  if (!Ctor) return null;
  sharedCtx = new Ctor();
  return sharedCtx;
}

/**
 * Decode + cache an audio URL. Optional `cacheKey` lets the caller share
 * one decoded buffer across multiple URL spellings — phrase audio uses
 * signed URLs that roll every hour, so caching by URL alone leaks decoded
 * copies under different keys for the same actual file. PhraseScreen
 * passes `${songId}:${phraseId}:${stem}` as the cache key so re-signing
 * the same phrase reuses the existing buffer.
 */
export async function getDecodedBuffer(
  url: string,
  cacheKey?: string,
): Promise<AudioBuffer | null> {
  const ctx = getAudioContext();
  if (!ctx) return null;
  const key = cacheKey ?? url;
  const existing = bufferCache.get(key);
  if (existing) {
    // Re-insert to mark as recently used.
    bufferCache.delete(key);
    bufferCache.set(key, existing);
    return existing;
  }
  const p = (async () => {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    return ctx.decodeAudioData(arr);
  })();
  bufferCache.set(key, p);
  // Bound the cache. Drop the oldest entry when over capacity.
  if (bufferCache.size > BUFFER_CACHE_MAX) {
    const oldestKey = bufferCache.keys().next().value;
    if (oldestKey) bufferCache.delete(oldestKey);
  }
  try {
    return await p;
  } catch (e) {
    bufferCache.delete(key);
    throw e;
  }
}

/** Fire-and-forget warm. Safe to call multiple times per URL. */
export function prefetchBuffer(url: string, cacheKey?: string): void {
  getDecodedBuffer(url, cacheKey).catch(() => {
    // prefetch failures are best-effort
  });
}

/** Drop every cached decoded buffer. Called on signOut so a different
 *  user's session doesn't reuse the previous user's audio. */
export function clearBufferCache(): void {
  bufferCache.clear();
}

export type PlaybackHandle = {
  /** Stop playback early. Safe to call after onEnded has already fired. */
  stop(): void;
};

/**
 * Play a short clip through the shared AudioContext. Returns null if the
 * browser has no Web Audio. Uses the decoded-buffer cache — first call on a URL
 * fetches + decodes, subsequent calls are instant.
 */
export async function playClip(
  url: string,
  opts?: { volume?: number; onEnded?: () => void; cacheKey?: string },
): Promise<PlaybackHandle | null> {
  const ctx = getAudioContext();
  if (!ctx) return null;
  let buffer: AudioBuffer | null = null;
  try {
    buffer = await getDecodedBuffer(url, opts?.cacheKey);
  } catch (e) {
    console.warn('playClip: decode failed', e);
    return null;
  }
  if (!buffer) return null;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  if (opts?.volume !== undefined && opts.volume !== 1) {
    const gain = ctx.createGain();
    gain.gain.value = opts.volume;
    source.connect(gain).connect(ctx.destination);
  } else {
    source.connect(ctx.destination);
  }
  if (opts?.onEnded) {
    source.onended = opts.onEnded;
  }
  source.start();

  return {
    stop: () => {
      try {
        source.onended = null;
        source.stop();
      } catch {
        // already stopped
      }
    },
  };
}
