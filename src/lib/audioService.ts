// One long-lived AudioContext + a decoded-buffer cache keyed by URL.
// - Safari caps per-page AudioContexts at ~4–6; we never new/close per session.
// - Every repeat attempt was paying fetch+decode cost on the count-in critical
//   path; caching by URL removes that round-trip on retakes.

type AudioCtor = typeof AudioContext;

let sharedCtx: AudioContext | null = null;
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

export async function getDecodedBuffer(url: string): Promise<AudioBuffer | null> {
  const ctx = getAudioContext();
  if (!ctx) return null;
  const existing = bufferCache.get(url);
  if (existing) return existing;
  const p = (async () => {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    return ctx.decodeAudioData(arr);
  })();
  bufferCache.set(url, p);
  try {
    return await p;
  } catch (e) {
    bufferCache.delete(url);
    throw e;
  }
}

/** Fire-and-forget warm. Safe to call multiple times per URL. */
export function prefetchBuffer(url: string): void {
  getDecodedBuffer(url).catch(() => {
    // prefetch failures are best-effort
  });
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
  opts?: { volume?: number; onEnded?: () => void },
): Promise<PlaybackHandle | null> {
  const ctx = getAudioContext();
  if (!ctx) return null;
  let buffer: AudioBuffer | null = null;
  try {
    buffer = await getDecodedBuffer(url);
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
