// Persisted "your-take playback sync" nudge in milliseconds. Layered on
// top of the auto-detected offset (0.05 + ctx.outputLatency) so the
// user can compensate for Bluetooth headphone latency that the browser
// may under-report. Positive value = shift voice LATER (voice was
// captured early because Bluetooth audible-time was even later than
// reported); negative = shift voice EARLIER (over-correction case).

import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

const KEY = 'sat:syncOffsetMs';
export const SYNC_OFFSET_DEFAULT_MS = 0;
export const SYNC_OFFSET_STEP_MS = 50;
// Range bumped to ±10s so users can compensate for very long
// Bluetooth chains or just slide their take to land in any other
// part of the song they want to overdub against.
export const SYNC_OFFSET_MIN_MS = -10000;
export const SYNC_OFFSET_MAX_MS = 10000;

function readStored(): number {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') {
    return SYNC_OFFSET_DEFAULT_MS;
  }
  const raw = localStorage.getItem(KEY);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n)
    ? Math.max(SYNC_OFFSET_MIN_MS, Math.min(SYNC_OFFSET_MAX_MS, n))
    : SYNC_OFFSET_DEFAULT_MS;
}

export function useSyncOffset(): [number, (v: number) => void] {
  const [ms, setMs] = useState<number>(SYNC_OFFSET_DEFAULT_MS);

  useEffect(() => {
    setMs(readStored());
  }, []);

  const update = useCallback((v: number) => {
    const clamped = Math.max(
      SYNC_OFFSET_MIN_MS,
      Math.min(SYNC_OFFSET_MAX_MS, Math.round(v / SYNC_OFFSET_STEP_MS) * SYNC_OFFSET_STEP_MS),
    );
    setMs(clamped);
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(KEY, String(clamped));
      } catch {
        // private mode; ignore
      }
    }
  }, []);

  return [ms, update];
}
