import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Chrome from '../components/Chrome';
import RetroButton from '../components/RetroButton';
import { COLORS, FONTS } from '../theme';

type Kind = 'privacy' | 'terms';

type Props = {
  kind: Kind;
  onBack: () => void;
};

export default function LegalScreen({ kind, onBack }: Props) {
  const content = kind === 'privacy' ? PRIVACY : TERMS;
  return (
    <Chrome title={content.title}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>{content.title}</Text>
          <RetroButton label="Back" onPress={onBack} size="sm" />
        </View>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
          <Text style={styles.updated}>Last updated 2026-05-01</Text>
          {content.sections.map((s, i) => (
            <View key={i} style={styles.section}>
              <Text style={styles.h2}>{s.h}</Text>
              {s.p.map((para, j) => (
                <Text key={j} style={styles.p}>
                  {para}
                </Text>
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
    </Chrome>
  );
}

const PRIVACY = {
  title: 'Privacy',
  sections: [
    {
      h: 'What we collect',
      p: [
        'Your email address (for sign-in via magic link).',
        'Audio you upload or paste a URL for, and the analysis we derive from it (stems, lyric transcripts, pitch curves, phrase slices).',
        'Your practice recordings and the pitch comparisons computed from them.',
        'Standard server logs (IP, user agent, request paths) for debugging.',
      ],
    },
    {
      h: 'How it is used',
      p: [
        'Audio and recordings are stored in private Supabase Storage buckets, scoped to your auth user. We use Postgres row-level security so other users — and unauthenticated visitors — can never read your library.',
        'Lyric transcripts are sent to LRCLIB (free public API) for matching against canonical lyrics, and to Anthropic when LRCLIB has no match. URLs you paste are sent to yt-dlp via a residential proxy for download.',
        'Practice take pitch summaries (no audio) are sent to Anthropic via a Supabase edge function so it can write one sentence of feedback. We do not send your raw recordings to Anthropic.',
      ],
    },
    {
      h: 'Retention',
      p: [
        'You can delete any uploaded song from the Library; that removes the original, all derived stems and slices, and all your recordings of it.',
        'Sign out at any time; your library remains tied to your email until you delete it.',
        'If you want your account fully removed, email joe.waine@gmail.com and we will purge your rows and storage.',
      ],
    },
    {
      h: 'Third parties',
      p: [
        'Supabase (auth, database, storage). Modal (worker compute). Render (web hosting). IPRoyal (residential proxy for URL ingest). LRCLIB (public lyrics API). Anthropic (lyrics fallback and written feedback). All transit is over TLS.',
      ],
    },
    {
      h: 'Contact',
      p: ['joe.waine@gmail.com'],
    },
  ],
};

const TERMS = {
  title: 'Terms',
  sections: [
    {
      h: 'What this is',
      p: [
        'Sing All The Time is a personal portfolio project that lets you upload audio and practice singing it back. It is provided as-is, with no warranty, no SLA, and no guarantee that it will keep running.',
      ],
    },
    {
      h: 'You are responsible for what you upload',
      p: [
        'Only upload audio you own or have rights to practice with. Do not upload copyrighted music you do not have rights to. Do not upload audio of other people without their consent.',
        'You retain ownership of anything you upload. We process it on your behalf to make the practice features work; we do not redistribute it.',
      ],
    },
    {
      h: 'Acceptable use',
      p: [
        'No automated scraping, bulk uploads, or pipeline abuse. The worker enforces 30 MB / 10 min / 3 in-flight / 10 per day limits per user; circumventing them is grounds for the account being removed.',
        'No uploading of illegal content, harassment material, or anything intended to deceive identifiable people.',
      ],
    },
    {
      h: 'Termination',
      p: [
        'We may remove your account or any uploads at any time, with or without notice, for any reason — including inactivity, abuse of resources, or copyright complaints.',
      ],
    },
    {
      h: 'Liability',
      p: [
        'Use this at your own risk. We are not responsible for lost recordings, processing errors, or anything that happens because you used this tool. If that is unacceptable, do not use it.',
      ],
    },
    {
      h: 'Contact',
      p: ['joe.waine@gmail.com'],
    },
  ],
};

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 24 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.black,
    marginBottom: 16,
  },
  title: { fontFamily: FONTS.chicago, fontWeight: '700', fontSize: 20, letterSpacing: -0.3 },
  scroll: { flex: 1 },
  body: { paddingBottom: 32, gap: 18 },
  section: { gap: 8 },
  updated: {
    fontFamily: FONTS.monaco,
    fontSize: 11,
    color: COLORS.softGrey,
    marginBottom: 4,
  },
  h2: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 14,
    letterSpacing: -0.2,
    marginTop: 4,
  },
  p: {
    fontFamily: FONTS.monaco,
    fontSize: 12,
    color: COLORS.black,
    lineHeight: 17,
  },
});
