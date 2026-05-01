import { StyleSheet, Text, View } from 'react-native';
import Chrome from '../components/Chrome';
import RetroButton from '../components/RetroButton';
import { BORDER_1BIT, COLORS, FONTS } from '../theme';

type Props = { onContinue: () => void };

export default function WelcomeScreen({ onContinue }: Props) {
  return (
    <Chrome>
      <View style={styles.container}>
        <View style={styles.top}>
          <Text style={styles.apple}>🎤</Text>
          <Text style={styles.title}>Sing All The Time</Text>
          <Text style={styles.subtitle}>Upload a song. Practice a phrase. Sing it back.</Text>
        </View>

        {/* Primary CTA + headphones hint sit right under the title so the
            button is always above the fold — even on short viewports
            (landscape phone, browser at half-height). The how-it-works
            steps below stay visible on a normal screen but graciously
            clip on the smallest ones; the user can already get into the
            app from the button without seeing them. */}
        <View style={styles.cta}>
          <Text style={styles.hint}>🎧 headphones recommended</Text>
          <RetroButton label="Let's sing" onPress={onContinue} size="lg" icon="play" />
        </View>

        <View style={styles.steps}>
          <Row
            n="1"
            title="Upload a song"
            body="mp3, wav, m4a, flac. We split the vocals and find the phrases for you."
          />
          <Row
            n="2"
            title="Pick a phrase"
            body="Count-in at the song's tempo, backing track, pitch roll on screen."
          />
          <Row
            n="3"
            title="Hear what to try next"
            body="Pitch analysis and one warm sentence of feedback per take."
          />
        </View>
      </View>
    </Chrome>
  );
}

function Row({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <View style={styles.row}>
      <View style={styles.numBubble}>
        <Text style={styles.num}>{n}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowBody}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 40,
    paddingBottom: 32,
    gap: 24,
  },
  top: { alignItems: 'center', gap: 10 },
  apple: { fontSize: 56 },
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
  },
  cta: { alignItems: 'center', gap: 14 },
  steps: { gap: 20 },
  row: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  numBubble: {
    width: 24,
    height: 24,
    ...BORDER_1BIT,
    borderRadius: 9999,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  num: { fontFamily: FONTS.chicago, fontWeight: '700', fontSize: 12 },
  rowTitle: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 15,
    letterSpacing: -0.3,
  },
  rowBody: {
    fontFamily: FONTS.monaco,
    fontSize: 12,
    color: COLORS.black,
    marginTop: 3,
    lineHeight: 17,
  },
  hint: { fontFamily: FONTS.monaco, fontSize: 12, color: COLORS.black },
});
