// Supabase Edge Function — Claude coach-voice feedback for a sung attempt.
//
// Contract:
//   POST { attempt_id: string } (Authorization: Bearer <user JWT>)
//   → { feedback: string, try_next: string }
//
// The caller's JWT flows through so RLS scopes the attempt lookup to their own
// rows. Service-role isn't used — we don't need to bypass RLS.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

- **Specific over generic.** Name the lyric, the note, the interval, the phrasing move.
- **Warm, not saccharine.** Notice something real. Don't perform enthusiasm.
- **Confident, not hedged.** "Try X" — never "maybe try X" or "you could try X".
- **Musical, not metric.** Translate numbers into feel. "68 cents flat" becomes "about a quarter-tone under the note" or "sitting just below it". The user doesn't care about cents.
- **Match the song.** A ballad deserves different feedback than a full-throat rock belt. Don't demand precision from a phrase that was meant to be sung loose.
- **When the mic caught very little** (hit_rate near zero, most notes have "no clear pitch detected"), don't invent feedback. Say something true: the mic didn't catch much — try the phrase again with a cleaner take.

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

function describeTilt(cents: number): string {
  if (Math.abs(cents) < 15) return "centered";
  if (cents > 0) return "consistently sharp";
  return "consistently flat";
}

function buildUserPrompt(attempt: {
  phrase: {
    lyric_text: string | null;
    song: {
      name: string;
      artist: string | null;
    };
  };
  pitch_analysis: PitchAnalysis;
}): string {
  const { song } = attempt.phrase;
  const pa = attempt.pitch_analysis;
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
Lyric: "${attempt.phrase.lyric_text ?? ""}"

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

  let body: { attempt_id?: string };
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

  const anthropic = new Anthropic({
    apiKey: Deno.env.get("ANTHROPIC_API_KEY")!,
  });

  try {
    // deno-lint-ignore no-explicit-any
    const response: any = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
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
          // deno-lint-ignore no-explicit-any
          content: buildUserPrompt(attempt as any),
        },
      ],
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: SCHEMA },
      },
    });

    const textBlock = response.content.find((b: { type: string }) => b.type === "text");
    if (!textBlock) return json({ error: "no text in response" }, 502);

    const parsed = JSON.parse(textBlock.text) as {
      feedback: string;
      try_next: string;
    };

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
