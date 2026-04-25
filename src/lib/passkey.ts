/** Magic-link-style sign-in (currently a stub, but designed so wiring up
 *  real Supabase magic links later is a one-file change).
 *
 *  How the stub works:
 *  - User types an email and submits.
 *  - We hash the email and use that hash as a localStorage key.
 *  - First sign-in for that email: anonymous Supabase auth → stash the
 *    session under the key. Next sign-in for the SAME email: pull the
 *    stashed session and re-auth with it. Same email = same user_id =
 *    same library.
 *  - "Sign out" clears the *current email pointer* but keeps stored
 *    sessions, so signing back in with the same email restores you.
 *
 *  When we move to real magic links, only `requestMagicLink` and the
 *  "Continue without email" path change — the rest of the app keeps using
 *  the same `getCurrentEmail` / `signedIn` machinery.
 */

import type { Session } from '@supabase/supabase-js';
import { hasSupabaseConfig, requireSupabase } from './supabase';

const CURRENT_EMAIL_KEY = 'sa.current_email';
const SESSION_KEY_PREFIX = 'sa.session.';

// Demo account: this email signs into a real email-auth Supabase user that
// owns the songs already in the DB. Other emails get a fresh anonymous
// session (and thus an empty library). The password lives in the bundle —
// same security model as the previous "singsong" passkey, since "Continue
// without email" already lets anyone in as some user.
const DEMO_EMAIL = 'demo@sing-anything.app';
const DEMO_PASSWORD = 'gjvVEiw5PEVvCb7dBF9nuzsJYnSldjK';

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Cheap stable digest of an email. NOT cryptographic; just enough to
 *  scope localStorage keys without storing the raw email everywhere. */
function emailKey(email: string): string {
  const normalized = email.trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) + h + normalized.charCodeAt(i)) | 0;
  }
  return `${SESSION_KEY_PREFIX}${(h >>> 0).toString(36)}`;
}

export function getCurrentEmail(): string | null {
  return storage()?.getItem(CURRENT_EMAIL_KEY) ?? null;
}

function setCurrentEmail(email: string) {
  storage()?.setItem(CURRENT_EMAIL_KEY, email.trim().toLowerCase());
}

function clearCurrentEmail() {
  storage()?.removeItem(CURRENT_EMAIL_KEY);
}

/** True iff the user has finished the (stubbed) magic-link dance. */
export function signedIn(): boolean {
  return !!getCurrentEmail();
}

/** Stub for the real magic-link request. Adds a small delay so the UI
 *  feels like a network call rather than instantaneous. */
export async function requestMagicLink(_email: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 700));
}

/**
 * Final step of sign-in. Restores or creates a Supabase session bound
 * to this email. Idempotent — calling it twice with the same email
 * returns the same user_id.
 */
export async function completeSignIn(email: string): Promise<void> {
  if (!hasSupabaseConfig) {
    setCurrentEmail(email);
    return;
  }

  const supabase = requireSupabase();
  const normalized = email.trim().toLowerCase();
  const key = emailKey(normalized);
  const store = storage();
  const stored = store?.getItem(key);

  if (stored) {
    try {
      const session = JSON.parse(stored) as Session;
      const { error } = await supabase.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
      if (!error) {
        setCurrentEmail(email);
        return;
      }
      // Stored session is rejected (refresh token expired etc.) — fall
      // through and re-mint a session for this email.
      console.warn('stored session rejected, creating fresh:', error);
      store?.removeItem(key);
    } catch (e) {
      console.warn('stored session unparseable, creating fresh:', e);
      store?.removeItem(key);
    }
  }

  // Demo account uses real password auth so we can return to the same
  // user_id (= access to the seed songs). Every other email gets an
  // anonymous session.
  let session: Session | null = null;
  if (normalized === DEMO_EMAIL) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    });
    if (error) throw error;
    session = data.session;
  } else {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
    session = data.session;
  }

  if (session && store) {
    store.setItem(key, JSON.stringify(session));
  }
  setCurrentEmail(email);
}

/** Soft sign-out: clear the email pointer but keep stored sessions, so
 *  signing back in with the same address re-attaches you to the same
 *  user_id (and library). Pair with supabase.auth.signOut() if you want
 *  to fully invalidate the JWT. */
export function signOut(): void {
  clearCurrentEmail();
  const supabase = hasSupabaseConfig ? requireSupabase() : null;
  // Best-effort revoke; if it fails the local pointer is already gone.
  void supabase?.auth.signOut();
}
