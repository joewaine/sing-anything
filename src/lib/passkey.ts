/** Very-soft gate for a private demo. Client-side only — anyone who reads
 *  the JS bundle can extract the passkey. Good for keeping drive-by visits
 *  out of a personal test instance, not for real security. */

const STORAGE_KEY = 'sa_passkey_ok';

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function hasPasskey(): boolean {
  const s = storage();
  // On native (no localStorage) we skip the gate entirely — assume the caller
  // is authorized by virtue of having the app installed.
  if (!s) return true;
  return s.getItem(STORAGE_KEY) === 'ok';
}

export function markPasskey(): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, 'ok');
  } catch {
    // private mode etc — just continue in-memory for this session
  }
}
