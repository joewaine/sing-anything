/**
 * Real magic-link sign-in via Supabase + Resend SMTP.
 *
 * Flow:
 *   1. User types email and submits.
 *   2. Demo email shortcut: signInWithPassword with bundled creds (no
 *      email is actually delivered to that address — it's a fake domain).
 *   3. Real email: signInWithOtp sends a magic link via Supabase, which
 *      hands the message to Resend SMTP. Email lands in user's inbox with
 *      a link back to our `emailRedirectTo` URL. Clicking the link puts
 *      `#access_token=…&refresh_token=…` on the URL; supabase-js's
 *      `detectSessionInUrl` (set in supabase.ts) parses it on cold load
 *      and the SIGNED_IN event fires for App.tsx's listener.
 *
 * Source of truth for "are we signed in?" is now `supabase.auth.getSession()`
 * — no more localStorage email pointer. supabase-js already persists the
 * session in its own storage key.
 */

import { hasSupabaseConfig, requireSupabase } from './supabase';

// Demo account: this email signs into a real email-auth Supabase user that
// owns the seed songs. Bypasses the magic-link round trip (we can't send
// to that fake domain). Password lives in the bundle — soft gate only.
const DEMO_EMAIL = 'demo@sing-anything.app';
const DEMO_PASSWORD = 'gjvVEiw5PEVvCb7dBF9nuzsJYnSldjK';

export async function getSession() {
  if (!hasSupabaseConfig) return null;
  const supabase = requireSupabase();
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/** True if there's an active Supabase session. Used by App to decide
 *  whether to show PasskeyScreen on cold load. */
export async function signedIn(): Promise<boolean> {
  return (await getSession()) !== null;
}

export type RequestResult = {
  /** True if we signed the user in directly (demo path). UI should skip
   *  the "check your inbox" state and unlock immediately. */
  immediate: boolean;
};

/**
 * Send a real magic link, or sign in immediately for the demo account.
 * Throws on Supabase errors so the caller can surface the message.
 */
export async function requestMagicLink(email: string): Promise<RequestResult> {
  const normalized = email.trim().toLowerCase();

  if (!hasSupabaseConfig) {
    // No backend wired — keep the UX feel for offline dev.
    await new Promise((r) => setTimeout(r, 700));
    return { immediate: false };
  }

  const supabase = requireSupabase();

  if (normalized === DEMO_EMAIL) {
    const { error } = await supabase.auth.signInWithPassword({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    });
    if (error) throw error;
    return { immediate: true };
  }

  const redirect = typeof window !== 'undefined'
    ? window.location.origin
    : undefined;

  const { error } = await supabase.auth.signInWithOtp({
    email: normalized,
    options: {
      emailRedirectTo: redirect,
      shouldCreateUser: true,
    },
  });
  if (error) throw error;
  return { immediate: false };
}

export async function signOut(): Promise<void> {
  if (!hasSupabaseConfig) return;
  const supabase = requireSupabase();
  await supabase.auth.signOut();
}
