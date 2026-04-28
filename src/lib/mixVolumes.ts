// Persisted per-source volume preferences for take playback. Three
// independent values for backing / lead vocal / your take, stored as
// a single JSON blob in localStorage so a single update doesn't
// stomp the other two. Defaults pick a "ducked" feel: backing audible
// but not overpowering, lead vocal slightly softer than the user's
// own take so they can hear themselves clearly against the music.

import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

export type MixVolumes = {
  backing: number;
  vocals: number;
  take: number;
};

const KEY = 'sat:mixVolumes';
export const MIX_DEFAULTS: MixVolumes = {
  backing: 0.7,
  vocals: 0.85,
  take: 1.0,
};

function clamp01(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function readStored(): MixVolumes {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') {
    return MIX_DEFAULTS;
  }
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return MIX_DEFAULTS;
    const parsed = JSON.parse(raw);
    return {
      backing: clamp01(parsed.backing) ?? MIX_DEFAULTS.backing,
      vocals: clamp01(parsed.vocals) ?? MIX_DEFAULTS.vocals,
      take: clamp01(parsed.take) ?? MIX_DEFAULTS.take,
    };
  } catch {
    return MIX_DEFAULTS;
  }
}

export function useMixVolumes(): [
  MixVolumes,
  (key: keyof MixVolumes, value: number) => void,
] {
  const [mix, setMix] = useState<MixVolumes>(MIX_DEFAULTS);

  useEffect(() => {
    setMix(readStored());
  }, []);

  const update = useCallback(
    (key: keyof MixVolumes, value: number) => {
      const clamped = Math.max(0, Math.min(1, value));
      setMix((prev) => {
        const next = { ...prev, [key]: clamped };
        if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
          try {
            localStorage.setItem(KEY, JSON.stringify(next));
          } catch {
            // private mode / quota — non-fatal
          }
        }
        return next;
      });
    },
    [],
  );

  return [mix, update];
}
