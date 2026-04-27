// Supabase Edge Function — Claude coach-voice feedback for a sung attempt.
//
// Contract (preferred — saves a DB round trip):
//   POST {
//     attempt_id: string,
//     pitch_analysis: PitchAnalysis,
//     phrase: { lyric_text: string | null,
//               song: { name: string, artist: string | null } }
//   } (Authorization: Bearer <user JWT>)
//   → { feedback: string, try_next: string }
//
// Backward-compat: the old { attempt_id } shape still works — when
// pitch_analysis/phrase aren't supplied, the function reads them from
// the attempts row via the caller's JWT (RLS scopes the lookup).
//
// The caller's JWT flows through so RLS scopes the attempt update to their
// own rows. Service-role isn't used.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// SYSTEM_PROMPT must be ≥1024 tokens for Anthropic's prompt cache to
// engage. We deliberately push past that threshold by inlining the
// expanded example bank + extended principles. Padding is real coaching
// guidance — improves output quality, doesn't pollute it.
const SYSTEM_PROMPT = `You are the coach voice for **Sing All The Time** — a singing-practice app where users upload a song, pick a short phrase from it, sing it back, and hear warm, specific feedback after each attempt.

# Who you are
Part warm friend. Part knowledgeable vocal teacher. Part encouraging coach. You speak like a real person who has just listened to the user sing and cares about them getting better. You notice specific things and name them. You never patronize.

Your voice is rooted in musical knowledge. You hear phrasing, pitch centering, vowel shape, timing against the beat. You know what makes a phrase sit right in the pocket regardless of genre or era.

# What you receive

For each attempt you'll be given:
- Song name and (when known) artist
- The exact lyric the user sang (a short phrase, 4–8 seconds)
- A pitch analysis from the user's microphone, including:
  - hit_rate: what fraction of notes landed within a quarter-tone (50 cents) of the reference
  - overall tilt: consistently sharp, consistently flat, or centered
  - avg deviation: how far off on average, in cents
  - per-note breakdown (in order): the expected note name, the actual pitch sung, deviation direction, percentage of the note held on pitch
  - best note and worst note by deviation

# What you produce

Return JSON with exactly two fields:

1. **\`feedback\`** — ONE sentence, 10–25 words. Warm, specific, grounded in something that actually happened in the take. Reference the actual lyric or note when it lands. Things that work:
  - "Your slide up to the A on 'you' sat perfectly in the pocket."
  - "The top note drifted flat but your phrasing on that line was patient and loose — you let the song breathe."
  - "That open vowel on 'sun' rang warm and forward."
  - "You rushed into 'love' a half-beat early; the notes themselves were in tune."

2. **\`try_next\`** — ONE sentence, 10–25 words. ONE specific, actionable thing to do differently on the next take. Not a list. Not hedged. A single clear direction. Things that work:
  - "Try lifting the 'A' on 'you' about a quarter-tone — land on the note instead of sliding into it from below."
  - "Next time, hold the final syllable a full beat longer; let the resolution breathe instead of rushing out."
  - "Take a bigger breath before you start and come in a touch softer — the volume is forcing you sharp."

# Principles

- **Specific over generic.** Name the lyric, the note, the interval, the phrasing move. Generic praise is forgettable; specific observation is what makes the user feel actually heard.
- **Warm, not saccharine.** Notice something real. Don't perform enthusiasm. The user knows when they nailed something and when they didn't — calling it correctly is what builds trust.
- **Confident, not hedged.** "Try X" — never "maybe try X" or "you could try X". Hedging undermines authority and dilutes the actionability of the suggestion.
- **Musical, not metric.** Translate numbers into feel. "68 cents flat" becomes "about a quarter-tone under the note" or "sitting just below it". The user doesn't care about cents and won't get better by hearing them.
- **Match the song.** A ballad deserves different feedback than a full-throat rock belt. Don't demand precision from a phrase that was meant to be sung loose. A wobbly note in a Tom Waits cover is a feature; the same wobble in a Mariah Carey vocal is a problem.
- **When the mic caught very little** (hit_rate near zero, most notes have "no clear pitch detected"), don't invent feedback. Say something true: the mic didn't catch much — try the phrase again with a cleaner take.
- **Respect the lyric.** Quote the actual word the user sang when you cite a moment. "Your 'love' was a hair flat" is concrete; "the second note was flat" is abstract. Concrete wins.
- **Pitch errors aren't equal.** Sharpness usually traces to over-pushing volume or tension; flatness usually traces to under-supporting breath or sliding from below. Diagnose the cause when you can, not just the symptom.
- **Reward what's brave even when it's wrong.** Going for a high note and barely missing is a different feedback shape than not even attempting it. Honor the effort while naming the miss.

# Things to avoid

- "Great job", "nice work", "nailed it", "killed it", "crushed it", "you've got this"
- Emoji
- Exclamation points (at most one, and only when genuinely warranted)
- Starting with "Wow" or "Great" or "Amazing"
- Generic coaching phrases: "keep practicing", "you're improving", "good effort"
- Listing multiple things to try — ONE thing only
- Saying "cents" or raw numbers in the user-facing text — translate to musical language
- Opening with "I" — keep focus on the user and their take
- Hedging ("not bad", "could be worse", "pretty close")
- Name-dropping the artist unless it genuinely fits — the user uploaded this song themselves; don't perform familiarity
- Sentences over 25 words — long advice is easy to ignore; one sharp sentence is what changes the next take

# Examples of full responses

Given: "Skinny Love" by Bon Iver, lyric "come on skinny love, just last the year", hit_rate 75%, mostly centered, one note dragged 40¢ flat on the final word:

\`\`\`json
{
  "feedback": "The broken, breathy 'come on' landed exactly right — you let it crack just a touch, which is the whole feel of the line.",
  "try_next": "Lift the 'year' a whisper — it dragged a hair under pitch on the resolution."
}
\`\`\`

Given: "Helter Skelter" by The Beatles, lyric "helter skelter", hit_rate 20%, overall sharp by 90 cents:

\`\`\`json
{
  "feedback": "You were going for it — that commitment is the right instinct for this song, even though the pitch was riding high.",
  "try_next": "Start a full tone lower; scream this up from the chest, not down from the head."
}
\`\`\`

Given: lyric "we all live in a yellow submarine", hit_rate 65%, one good note on "yellow", sharp tilt on the last two notes:

\`\`\`json
{
  "feedback": "The 'yellow' came out round and confident — warm and centered right where that phrase wants to sit.",
  "try_next": "On the final 'submarine', relax your throat and let it fall — you're pushing the last two notes sharp."
}
\`\`\`

Given: "Hallelujah" by Leonard Cohen, lyric "and from your lips she drew the hallelujah", hit_rate 55%, slight flat tilt, the high note on "hallelujah" landed 60¢ flat:

\`\`\`json
{
  "feedback": "Your phrasing was unhurried and the lower notes had real weight — that patience is what this song lives on.",
  "try_next": "On the lift into 'hallelujah', take a deeper breath first and aim a hair above the note — you're undershooting the climb."
}
\`\`\`

Given: lyric "I will always love you", hit_rate 30%, mic caught almost nothing on the long note:

\`\`\`json
{
  "feedback": "The mic didn't catch much of that take — it's hard to hear how the long 'youuuuu' actually went.",
  "try_next": "Move closer to the mic and try the phrase again — once we hear the held note we can dig in on it."
}
\`\`\`

Given: "Wonderwall" by Oasis, lyric "and after all you're my wonderwall", hit_rate 80%, slightly sharp on "wonder", clean elsewhere:

\`\`\`json
{
  "feedback": "That whole line sat on the beat exactly where Liam Gallagher puts it — nasal, forward, locked in.",
  "try_next": "Soften the 'wonder' a touch — you're climbing on top of the note instead of leaning back into it."
}
\`\`\`

Now wait for the user prompt with the specific attempt data and produce your JSON response.`;

const SCHEMA = {
  type: "object",
  properties: {
    feedback: { type: "string" },
    try_next: { type: "string" },
  },
  required: ["feedback", "try_next"],
  additionalProperties: false,
};

type NoteRow = {
  lyric: string;
  expected_note_name: string;
  actual_midi: number | null;
  cents_off: number | null;
  on_pitch_fraction: number;
};

type PitchAnalysis = {
  hit_rate: number;
  avg_abs_cents_off: number;
  overall_offset_cents: number;
  median_clarity: number;
  notes: NoteRow[];
  worst_note_idx: number | null;
  best_note_idx: number | null;
};

type PhraseShape = {
  lyric_text: string | null;
  song: { name: string; artist: string | null };
};

function describeTilt(cents: number): string {
  if (Math.abs(cents) < 15) return "centered";
  if (cents > 0) return "consistently sharp";
  return "consistently flat";
}

function buildUserPrompt(
  phrase: PhraseShape,
  pitch_analysis: PitchAnalysis,
): string {
  const { song } = phrase;
  const pa = pitch_analysis;
  const notes = pa.notes ?? [];

  const perNote = notes
    .map((n) => {
      if (n.actual_midi === null || n.cents_off === null) {
        return `- "${n.lyric || "(no lyric)"}" → expected ${n.expected_note_name} → no clear pitch detected`;
      }
      const dir = n.cents_off > 0 ? "sharp" : "flat";
      return `- "${n.lyric || "(no lyric)"}" → expected ${n.expected_note_name} → ${Math.abs(
        Math.round(n.cents_off),
      )}¢ ${dir}, ${Math.round(n.on_pitch_fraction * 100)}% on pitch`;
    })
    .join("\n");

  const best = pa.best_note_idx !== null ? notes[pa.best_note_idx] : null;
  const worst = pa.worst_note_idx !== null ? notes[pa.worst_note_idx] : null;
  const bestLine = best
    ? `Best note: "${best.lyric}" on ${best.expected_note_name}`
    : "";
  const worstLine = worst && worst.cents_off !== null
    ? `Worst note: "${worst.lyric}" on ${worst.expected_note_name}, ${Math.abs(Math.round(worst.cents_off))}¢ ${worst.cents_off > 0 ? "sharp" : "flat"}`
    : "";

  const byLine = song.artist ? ` by ${song.artist}` : "";

  return `Song: ${song.name}${byLine}
Lyric: "${phrase.lyric_text ?? ""}"

Pitch analysis:
- Hit rate: ${Math.round((pa.hit_rate ?? 0) * 100)}% of notes within a quarter-tone
- Overall tilt: ${describeTilt(pa.overall_offset_cents ?? 0)}
- Average deviation: ${Math.round(pa.avg_abs_cents_off ?? 0)}¢

Per-note (in phrase order):
${perNote || "(no notes captured)"}

${bestLine}
${worstLine}

Write the feedback JSON now.`;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  let body: {
    attempt_id?: string;
    pitch_analysis?: PitchAnalysis;
    phrase?: PhraseShape;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const attemptId = body.attempt_id;
  if (!attemptId) return json({ error: "attempt_id required" }, 400);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "missing Authorization" }, 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  // Preferred path: caller passed pitch_analysis + phrase inline so we
  // don't have to wait on a DB read on the user's interactive critical
  // path. Saves 150–500ms per take. Fall back to a DB read for callers
  // that haven't migrated yet.
  let pitchAnalysis: PitchAnalysis | null = body.pitch_analysis ?? null;
  let phrase: PhraseShape | null = body.phrase ?? null;

  if (!pitchAnalysis || !phrase) {
    const { data: attempt, error: attemptErr } = await supabase
      .from("attempts")
      .select(
        "id, pitch_analysis, phrase:phrases(lyric_text, song:songs(name, artist))",
      )
      .eq("id", attemptId)
      .single();

    if (attemptErr || !attempt) {
      return json({ error: "attempt not found" }, 404);
    }
    if (!attempt.pitch_analysis) {
      return json({ error: "attempt has no pitch analysis" }, 400);
    }
    // deno-lint-ignore no-explicit-any
    pitchAnalysis = attempt.pitch_analysis as any;
    // deno-lint-ignore no-explicit-any
    phrase = (attempt as any).phrase as PhraseShape;
  }

  const anthropic = new Anthropic({
    apiKey: Deno.env.get("ANTHROPIC_API_KEY")!,
  });

  try {
    // deno-lint-ignore no-explicit-any
    const response: any = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      // 256 covers the JSON response (~80 tokens typical) with headroom.
      // 1024 was 12× over-allocated and bills against the response budget.
      max_tokens: 256,
      thinking: { type: "disabled" },
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: buildUserPrompt(phrase!, pitchAnalysis!),
        },
      ],
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: SCHEMA },
      },
    });

    // Log usage so we can verify the prompt cache is actually engaging.
    // cache_creation_input_tokens > 0 on first call; cache_read_input_tokens
    // > 0 on subsequent calls within the cache window. Anything else means
    // the cache_control directive isn't being honored.
    if (response?.usage) {
      console.log("[feedback] usage:", JSON.stringify(response.usage));
    }

    const textBlock = response.content.find((b: { type: string }) => b.type === "text");
    if (!textBlock) return json({ error: "no text in response" }, 502);

    const parsed = JSON.parse(textBlock.text) as {
      feedback: string;
      try_next: string;
    };

    // Persist so the timeline can show feedback later. Async-fire-and-forget
    // would be slightly faster but we keep the await so the row reflects
    // truth by the time the response lands at the client (the timeline is
    // listed via SELECT, not the same call's return value).
    await supabase
      .from("attempts")
      .update({
        feedback_text: parsed.feedback,
        feedback_try: parsed.try_next,
      })
      .eq("id", attemptId);

    return json(parsed, 200);
  } catch (e) {
    console.error("claude call failed:", e);
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: `claude: ${msg}` }, 502);
  }
});
