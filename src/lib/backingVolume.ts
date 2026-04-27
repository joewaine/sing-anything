// Persisted backing-track volume preference.
// Web stores in localStorage so a user's tweak survives a reload. Native
// falls through to in-memory only (good enough for v1 — most singers won't
// reinstall mid-practice). Defaults bumped to 0.7 from 0.55 after older
// users reported the accompaniment was too quiet to hear under headphones.

import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

const KEY = 'sat:backingVolume';
export const BACKING_VOLUME_DEFAULT = 0.7;
export const BACKING_VOLUME_STEPS = [0.3, 0.45, 0.6, 0.75, 0.9, 1.0];

function readStored(): number {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') {
    return BACKING_VOLUME_DEFAULT;
  }
  const raw = localStorage.getItem(KEY);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : BACKING_VOLUME_DEFAULT;
}

export function useBackingVolume(): [number, (v: number) => void] {
  const [vol, setVol] = useState<number>(BACKING_VOLUME_DEFAULT);

  useEffect(() => {
    setVol(readStored());
  }, []);

  const update = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVol(clamped);
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(KEY, String(clamped));
      } catch {
        // Storage might be disabled (private mode) — non-fatal.
      }
    }
  }, []);

  return [vol, update];
}

export function nextStep(current: number, dir: 1 | -1): number {
  const steps = BACKING_VOLUME_STEPS;
  // Find closest step to current, then step from there. Avoids ratcheting
  // bugs when current is between steps.
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < steps.length; i++) {
    const d = Math.abs(steps[i] - current);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  const nextIdx = Math.max(0, Math.min(steps.length - 1, bestIdx + dir));
  return steps[nextIdx];
}
