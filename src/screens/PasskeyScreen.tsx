import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Chrome from '../components/Chrome';
import RetroButton from '../components/RetroButton';
import { requestMagicLink } from '../lib/passkey';
import { BORDER_1BIT, COLORS, FONTS } from '../theme';

type Props = {
  onUnlock: () => void;
  onShowPrivacy?: () => void;
  onShowTerms?: () => void;
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; email: string; canResend: boolean }
  | { kind: 'error'; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// How long to wait before letting the user resend a magic link. Resend is
// idempotent on Supabase's side (same email → same link), but the user has
// to click *something* if it never arrives — silently sitting on
// "check your inbox" forever is the failure mode we're avoiding.
const RESEND_DELAY_MS = 60_000;

export default function PasskeyScreen({ onUnlock, onShowPrivacy, onShowTerms }: Props) {
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const inputRef = useRef<TextInput>(null);

  // After we land on the "sent" state, unlock the Resend button after a
  // delay so it isn't immediately spam-able but also doesn't leave the
  // user stranded if Resend SMTP eats the message.
  useEffect(() => {
    if (phase.kind !== 'sent' || phase.canResend) return;
    const t = setTimeout(() => {
      setPhase((p) => (p.kind === 'sent' ? { ...p, canResend: true } : p));
    }, RESEND_DELAY_MS);
    return () => clearTimeout(t);
  }, [phase]);

  const submit = async (overrideEmail?: string) => {
    const e = (overrideEmail ?? email).trim().toLowerCase();
    if (!EMAIL_RE.test(e)) {
      setPhase({ kind: 'error', message: 'That doesn\'t look like an email.' });
      return;
    }
    try {
      setPhase({ kind: 'sending' });
      const { immediate } = await requestMagicLink(e);
      if (immediate) {
        // Demo path — signed in already. Hand off to App.
        onUnlock();
      } else {
        setPhase({ kind: 'sent', email: e, canResend: false });
      }
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const resend = () => {
    if (phase.kind !== 'sent') return;
    void submit(phase.email);
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
              <Text style={styles.sentEmail}>{phase.email}</Text>
            </Text>
            <Text style={styles.sentHint}>
              Click the link in the email to finish signing in. The page will
              update automatically.
            </Text>
            {phase.canResend ? (
              <View style={{ marginTop: 14 }}>
                <RetroButton label="Resend link" onPress={resend} size="md" />
              </View>
            ) : (
              <Text style={[styles.sentHint, { marginTop: 14 }]}>
                Didn't arrive? You can resend in a minute.
              </Text>
            )}
            <Text
              style={styles.tinyLink}
              onPress={() => {
                setEmail('');
                setPhase({ kind: 'idle' });
              }}
            >
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
              onSubmitEditing={() => submit()}
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
                  onPress={() => submit()}
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
          {(onShowPrivacy || onShowTerms) && (
            <View style={styles.footer}>
              {onShowPrivacy && (
                <Pressable onPress={onShowPrivacy} hitSlop={6}>
                  <Text style={styles.footerLink}>Privacy</Text>
                </Pressable>
              )}
              {onShowPrivacy && onShowTerms && <Text style={styles.footerSep}>·</Text>}
              {onShowTerms && (
                <Pressable onPress={onShowTerms} hitSlop={6}>
                  <Text style={styles.footerLink}>Terms</Text>
                </Pressable>
              )}
            </View>
          )}
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
    width: '100%',
    maxWidth: 280,
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
    marginTop: 18,
  },
  bottom: { alignItems: 'center', gap: 12 },
  hint: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.softGrey,
    textAlign: 'center',
    maxWidth: 320,
    lineHeight: 15,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  footerLink: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.black,
    textDecorationLine: 'underline',
  },
  footerSep: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.softGrey,
  },
});
