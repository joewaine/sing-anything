import { hasSupabaseConfig, requireSupabase } from './supabase';

/** Ensures the client has a session; signs in anonymously if not.
 *  No-ops (returns null) if Supabase env vars are unset — lets the Phase 1
 *  shell render without a backend. */
export async function ensureSignedIn() {
  if (!hasSupabaseConfig) return null;
  const supabase = requireSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (session) return session;
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.session;
}
