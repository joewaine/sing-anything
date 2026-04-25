import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import FontLoader from './src/components/FontLoader';
import LibraryScreen from './src/screens/LibraryScreen';
import PasskeyScreen from './src/screens/PasskeyScreen';
import PickerScreen from './src/screens/PickerScreen';
import SessionScreen from './src/screens/SessionScreen';
import UploadScreen from './src/screens/UploadScreen';
import WelcomeScreen from './src/screens/WelcomeScreen';
import { ensureSignedIn } from './src/lib/auth';
import { signedIn } from './src/lib/passkey';
import { fetchFullPhrase } from './src/lib/phrases';
import { currentHashRoute, pathToRoute, routeToPath, type Route } from './src/lib/routing';
import { hasSupabaseConfig } from './src/lib/supabase';
import { COLORS, FONTS } from './src/theme';

export default function App() {
  const [unlocked, setUnlocked] = useState(() => signedIn());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(() => currentHashRoute() ?? { screen: 'welcome' });

  useEffect(() => {
    if (!unlocked) return;
    // The PasskeyScreen's `completeSignIn` already restored or minted a
    // session; ensureSignedIn() is a safety net for the corner case where
    // localStorage has an email but Supabase rejected the stashed session.
    ensureSignedIn()
      .then(() => setReady(true))
      .catch((e: Error) => setError(e.message));
  }, [unlocked]);

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
    const path = routeToPath(route);
    const current = window.location.hash.replace(/^#/, '') || '/';
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
      {!unlocked ? (
        <PasskeyScreen onUnlock={() => setUnlocked(true)} />
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>AUTH FAILED</Text>
          <Text style={styles.errorBody}>{error}</Text>
          <Text style={styles.errorHint}>
            Enable "Anonymous Sign-ins" in Supabase → Authentication → Providers.
          </Text>
        </View>
      ) : !ready ? (
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.black} />
          {!hasSupabaseConfig && (
            <Text style={styles.errorHint}>
              No Supabase env vars set — running in shell-only mode.
            </Text>
          )}
        </View>
      ) : route.screen === 'welcome' ? (
        <WelcomeScreen onContinue={() => setRoute({ screen: 'library' })} />
      ) : route.screen === 'library' ? (
        <LibraryScreen
          onUpload={() => setRoute({ screen: 'upload' })}
          onPickSong={(song) => setRoute({ screen: 'picker', songId: song.id })}
          onBack={() => setRoute({ screen: 'welcome' })}
        />
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
