import { useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import Chrome from '../components/Chrome';
import RetroButton from '../components/RetroButton';
import { BORDER_1BIT, COLORS, FONTS } from '../theme';

type Props = {
  onUnlock: () => void;
};

const PASSKEY = 'singsong';

/** Client-side soft gate. Trivially bypassable by reading the JS bundle, but
 *  enough to keep drive-by strangers out of a personal demo. */
export default function PasskeyScreen({ onUnlock }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  const submit = () => {
    if (value.trim().toLowerCase() === PASSKEY) {
      setError(null);
      onUnlock();
    } else {
      setError('Wrong passkey.');
      inputRef.current?.focus();
    }
  };

  return (
    <Chrome>
      <View style={styles.container}>
        <View style={styles.top}>
          <Text style={styles.emoji}>🍏</Text>
          <Text style={styles.title}>Sing Anything</Text>
          <Text style={styles.subtitle}>Private demo — enter the passkey to continue.</Text>
        </View>

        <View style={styles.form}>
          <TextInput
            ref={inputRef}
            value={value}
            onChangeText={setValue}
            onSubmitEditing={submit}
            placeholder="passkey"
            placeholderTextColor={COLORS.softGrey}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            returnKeyType="go"
            style={styles.input}
            autoFocus
          />
          {error && <Text style={styles.error}>{error}</Text>}
          <View style={{ marginTop: 16 }}>
            <RetroButton label="Unlock" onPress={submit} size="lg" icon="play" variant="dark" />
          </View>
        </View>

        <View style={styles.bottom}>
          <Text style={styles.hint}>Ask the person who sent you this link if you don't know it.</Text>
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
    width: 260,
    backgroundColor: COLORS.white,
    textAlign: 'center',
    letterSpacing: 2,
  },
  error: {
    fontFamily: FONTS.monaco,
    fontSize: 12,
    color: '#c00',
    marginTop: 6,
  },
  bottom: { alignItems: 'center' },
  hint: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.softGrey,
    textAlign: 'center',
  },
});
