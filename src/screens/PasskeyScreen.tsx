import { useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import Chrome from '../components/Chrome';
import RetroButton from '../components/RetroButton';
import { completeSignIn, requestMagicLink } from '../lib/passkey';
import { BORDER_1BIT, COLORS, FONTS } from '../theme';

type Props = {
  onUnlock: () => void;
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'error'; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Stubbed magic-link sign-in. The UX is identical to the real flow we'll
 *  ship later (email → check inbox → click). For now the "Continue without
 *  email" button skips the inbox step. */
export default function PasskeyScreen({ onUnlock }: Props) {
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const inputRef = useRef<TextInput>(null);

  const submit = async () => {
    const e = email.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) {
      setPhase({ kind: 'error', message: 'That doesn\'t look like an email.' });
      return;
    }
    try {
      setPhase({ kind: 'sending' });
      await requestMagicLink(e);
      setPhase({ kind: 'sent' });
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const skipAndContinue = async () => {
    const e = email.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) {
      setPhase({ kind: 'error', message: 'Enter your email above first.' });
      return;
    }
    try {
      setPhase({ kind: 'sending' });
      await completeSignIn(e);
      onUnlock();
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <Chrome>
      <View style={styles.container}>
        <View style={styles.top}>
          <Text style={styles.emoji}>🍏</Text>
          <Text style={styles.title}>Sing All The Time</Text>
          <Text style={styles.subtitle}>
            Sign in with your email — your library and recordings stay tied to
            it.
          </Text>
        </View>

        {phase.kind === 'sent' ? (
          <View style={styles.form}>
            <Text style={styles.sentTitle}>Check your inbox</Text>
            <Text style={styles.sentBody}>
              We sent a sign-in link to{'\n'}
              <Text style={styles.sentEmail}>{email}</Text>
            </Text>
            <Text style={styles.sentHint}>
              Click the link to continue. (Demo: emails aren't actually being
              sent yet — use the button below.)
            </Text>
            <View style={{ marginTop: 18 }}>
              <RetroButton
                label="Continue without email →"
                onPress={skipAndContinue}
                size="lg"
                variant="dark"
              />
            </View>
            <Text style={styles.tinyLink} onPress={() => setPhase({ kind: 'idle' })}>
              Use a different email
            </Text>
          </View>
        ) : (
          <View style={styles.form}>
            <TextInput
              ref={inputRef}
              value={email}
              onChangeText={(v) => {
                setEmail(v);
                if (phase.kind === 'error') setPhase({ kind: 'idle' });
              }}
              onSubmitEditing={submit}
              placeholder="you@example.com"
              placeholderTextColor={COLORS.softGrey}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              returnKeyType="go"
              style={styles.input}
              autoFocus
              editable={phase.kind !== 'sending'}
            />
            {phase.kind === 'error' && <Text style={styles.error}>{phase.message}</Text>}
            <View style={{ marginTop: 16 }}>
              {phase.kind === 'sending' ? (
                <ActivityIndicator color={COLORS.black} />
              ) : (
                <RetroButton
                  label="Send magic link"
                  onPress={submit}
                  size="lg"
                  icon="play"
                  variant="dark"
                />
              )}
            </View>
          </View>
        )}

        <View style={styles.bottom}>
          <Text style={styles.hint}>
            Your library is private — only you can see your uploads and
            recordings.
          </Text>
        </View>
      </View>
    </Chrome>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 56,
    paddingBottom: 32,
    justifyContent: 'space-between',
  },
  top: { alignItems: 'center', gap: 10 },
  emoji: { fontSize: 56 },
  title: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 32,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontFamily: FONTS.monaco,
    fontSize: 13,
    color: COLORS.black,
    textAlign: 'center',
    maxWidth: 320,
    lineHeight: 17,
  },
  form: { alignItems: 'center', gap: 6, marginVertical: 20 },
  input: {
    ...BORDER_1BIT,
    fontFamily: FONTS.monaco,
    fontSize: 16,
    paddingVertical: 10,
    paddingHorizontal: 14,
    width: 280,
    backgroundColor: COLORS.white,
    textAlign: 'center',
  },
  error: {
    fontFamily: FONTS.monaco,
    fontSize: 12,
    color: '#c00',
    marginTop: 6,
  },
  sentTitle: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 18,
    marginTop: 8,
  },
  sentBody: {
    fontFamily: FONTS.monaco,
    fontSize: 13,
    color: COLORS.black,
    textAlign: 'center',
    lineHeight: 18,
    maxWidth: 320,
    marginTop: 4,
  },
  sentEmail: { fontWeight: '700' },
  sentHint: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.softGrey,
    textAlign: 'center',
    marginTop: 12,
    maxWidth: 320,
    lineHeight: 15,
  },
  tinyLink: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.softGrey,
    textDecorationLine: 'underline',
    marginTop: 14,
  },
  bottom: { alignItems: 'center' },
  hint: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.softGrey,
    textAlign: 'center',
    maxWidth: 320,
    lineHeight: 15,
  },
});
