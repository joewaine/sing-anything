import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import FontLoader from './src/components/FontLoader';
import CalibrationScreen from './src/screens/CalibrationScreen';
import LibraryScreen from './src/screens/LibraryScreen';
import PasskeyScreen from './src/screens/PasskeyScreen';
import PickerScreen from './src/screens/PickerScreen';
import SessionScreen from './src/screens/SessionScreen';
import TakesScreen from './src/screens/TakesScreen';
import UploadScreen from './src/screens/UploadScreen';
import WelcomeScreen from './src/screens/WelcomeScreen';
import { signOut } from './src/lib/passkey';
import { fetchFullPhrase } from './src/lib/phrases';
import { currentHashRoute, pathToRoute, routeToPath, type Route } from './src/lib/routing';
import { hasSupabaseConfig, requireSupabase } from './src/lib/supabase';
import { COLORS, FONTS } from './src/theme';

export default function App() {
  // `unlocked` is null until we've finished checking the Supabase session
  // on cold load. true = show app, false = show PasskeyScreen, null = the
  // brief loading state before either decision.
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(() => currentHashRoute() ?? { screen: 'welcome' });

  // /debug auto-login. Hitting #/debug triggers signInWithPassword for the
  // owner email so dev iterations don't require a fresh magic link each
  // visit. Password lives in EXPO_PUBLIC_DEBUG_PASSWORD on Render's env;
  // route is unlisted on purpose. Anyone who guesses the URL gets in,
  // so we don't put privileged data behind this account — same trust
  // model as a localStorage-backed cookie.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const hash = window.location.hash.replace(/^#/, '');
    if (hash !== '/debug') return;
    if (!hasSupabaseConfig) return;

    const password = process.env.EXPO_PUBLIC_DEBUG_PASSWORD;
    if (!password) {
      setError('EXPO_PUBLIC_DEBUG_PASSWORD not set in env — /debug disabled.');
      return;
    }
    const supabase = requireSupabase();
    void (async () => {
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: 'joe.waine@gmail.com',
        password,
      });
      if (signInErr) {
        setError(`Debug auth failed: ${signInErr.message}`);
        return;
      }
      window.history.replaceState({}, '', '#/library');
      setRoute({ screen: 'library' });
    })();
  }, []);

  // Source of truth for "are we signed in?" is Supabase's session. On cold
  // load, supabase-js parses the URL hash for magic-link tokens (we
  // configured `detectSessionInUrl: true` in supabase.ts), then fires
  // SIGNED_IN. We listen for that and update `unlocked` accordingly.
  useEffect(() => {
    if (!hasSupabaseConfig) {
      setUnlocked(false);
      return;
    }
    const supabase = requireSupabase();

    void supabase.auth.getSession().then(({ data }) => {
      setUnlocked(!!data.session);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        setUnlocked(!!session);
      } else if (event === 'SIGNED_OUT') {
        setUnlocked(false);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  // Browser history ⇆ route. On web, listen for popstate (back/forward) and
  // pushState on route changes so the URL reflects the current screen.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    const onPop = () => {
      const next = pathToRoute(window.location.hash) ?? { screen: 'welcome' };
      setRoute(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const currentHash = window.location.hash.replace(/^#/, '');
    // Don't clobber Supabase's auth callback hash. After clicking a magic
    // link, the URL is `#access_token=…&refresh_token=…&…`; supabase-js
    // parses that asynchronously inside `detectSessionInUrl`. If we
    // pushState our route hash before that parse finishes, the tokens
    // are lost and the user gets bounced back to the sign-in screen.
    // Once supabase consumes the hash it calls history.replaceState
    // to clear it, and we'll start syncing routes normally on the
    // next route change.
    if (
      currentHash.includes('access_token=') ||
      currentHash.includes('refresh_token=') ||
      currentHash.startsWith('error=') ||
      currentHash.includes('&error=')
    ) {
      return;
    }
    const path = routeToPath(route);
    const current = currentHash || '/';
    if (path !== current) {
      window.history.pushState({}, '', `#${path}`);
    }
  }, [route]);

  // If we landed on /session/<id> (URL-direct navigation or forward button)
  // we don't have a hydrated phrase yet — fetch it.
  useEffect(() => {
    if (route.screen !== 'session') return;
    if (route.phrase && route.phrase.id === route.phraseId) return;
    let cancelled = false;
    (async () => {
      try {
        const phrase = await fetchFullPhrase(route.phraseId);
        if (cancelled) return;
        setRoute((r) =>
          r.screen === 'session' && r.phraseId === phrase.id
            ? { ...r, phrase }
            : r,
        );
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route]);

  return (
    <>
      <FontLoader />
      <StatusBar style="dark" />
      {unlocked === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.black} />
        </View>
      ) : !unlocked ? (
        <PasskeyScreen onUnlock={() => setUnlocked(true)} />
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>AUTH FAILED</Text>
          <Text style={styles.errorBody}>{error}</Text>
        </View>
      ) : route.screen === 'welcome' ? (
        <WelcomeScreen onContinue={() => setRoute({ screen: 'library' })} />
      ) : route.screen === 'library' ? (
        <LibraryScreen
          onUpload={() => setRoute({ screen: 'upload' })}
          onPickSong={(song) => setRoute({ screen: 'picker', songId: song.id })}
          onYourTakes={() => setRoute({ screen: 'takes' })}
          onCalibrate={() => setRoute({ screen: 'calibrate' })}
          onSignOut={() => {
            void signOut();
            // onAuthStateChange will fire SIGNED_OUT and flip `unlocked`,
            // but reset the route immediately so the UI snaps back.
            setRoute({ screen: 'welcome' });
          }}
        />
      ) : route.screen === 'takes' ? (
        <TakesScreen onBack={() => setRoute({ screen: 'library' })} />
      ) : route.screen === 'calibrate' ? (
        <CalibrationScreen onBack={() => setRoute({ screen: 'library' })} />
      ) : route.screen === 'upload' ? (
        <UploadScreen
          onBack={() => setRoute({ screen: 'library' })}
          onReady={() => setRoute({ screen: 'library' })}
        />
      ) : route.screen === 'picker' ? (
        <PickerScreen
          songId={route.songId}
          onPick={(summary) =>
            setRoute({ screen: 'session', phraseId: summary.id, phrase: null })
          }
          onBack={() => setRoute({ screen: 'library' })}
        />
      ) : route.phrase ? (
        <SessionScreen
          phrase={route.phrase}
          onBack={() =>
            setRoute({ screen: 'picker', songId: route.phrase!.song_id })
          }
        />
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.black} />
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.grey,
    padding: 32,
    gap: 10,
  },
  errorTitle: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 14,
    letterSpacing: 2,
    color: '#c00',
  },
  errorBody: {
    fontFamily: FONTS.monaco,
    fontSize: 12,
    color: COLORS.black,
    textAlign: 'center',
    maxWidth: 320,
  },
  errorHint: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.black,
    textAlign: 'center',
    opacity: 0.7,
  },
});
