// Persisted toggle for whether to run pitch analysis after a take.
// Default OFF — analysis takes a few seconds and isn't always wanted
// (sometimes a user just wants to record themselves practicing
// without scoring). When OFF, stopRecording skips runAnalysisAndSave
// + Claude feedback; the done view just shows SAVED.

import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

const KEY = 'sat:analysisEnabled';
const DEFAULT = false;

function readStored(): boolean {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') {
    return DEFAULT;
  }
  return localStorage.getItem(KEY) === 'true';
}

export function useAnalysisEnabled(): [boolean, (v: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(DEFAULT);

  useEffect(() => {
    setEnabled(readStored());
  }, []);

  const update = useCallback((v: boolean) => {
    setEnabled(v);
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(KEY, String(v));
      } catch {
        // private mode — non-fatal
      }
    }
  }, []);

  return [enabled, update];
}
