# Sing Anything — Project Kickoff

You are picking up a new project called **Sing Anything**. Read this whole doc before writing any code — the plan is dense but complete, and the constraints matter. When you finish reading, respond with a one-paragraph plan of attack and wait for the user to confirm before you start scaffolding.

## The one-line pitch

Sing Anything is **Sing Beatles but you can upload any song**. Same practice-a-phrase UI, same pitch feedback, same Claude coach — but the song library is whatever the user drops in, not a fixed set of 73 Beatles tracks.

## Two reference projects (read them first)

Both live in the same parent folder as this one (`/Users/josephwaine/fractal/`):

- **`sing-beatles/`** — the production app whose UI and session flow you are cloning. Do NOT modify it. Read it. The user was explicit: *"dont mess with this folder, just create everything necessary in a new folder."*
- **`demucs/`** — a tiny Flask reference app that runs Meta's Demucs model to split an audio file into `drums/bass/vocals/other`. This is the stemming primitive you'll wrap.

**Before writing anything**, read at minimum:

1. `sing-beatles/App.tsx` — navigation shell
2. `sing-beatles/src/screens/SessionScreen.tsx` — the core practice loop (mic capture → countdown → record → upload → feedback). This file is the soul of the UX.
3. `sing-beatles/src/screens/PickerScreen.tsx` — song/phrase picker UI
4. `sing-beatles/src/components/PitchRibbon.tsx` — scrolling piano-roll-with-lyrics widget
5. `sing-beatles/src/components/LyricStrip.tsx` — karaoke-style lyric highlight
6. `sing-beatles/src/components/WaveformCanvas.tsx` — live oscillogram during recording
7. `sing-beatles/src/lib/recorder.ts` — platform-split mic capture (Web uses MediaRecorder; native uses expo-av)
8. `sing-beatles/src/lib/countIn.ts` — Web Audio metronome + backing scheduler
9. `sing-beatles/src/lib/pitch.ts` — pitchy-based pitch extraction of the recorded attempt
10. `sing-beatles/src/lib/feedback.ts` — calls the Supabase edge function to get Claude coach feedback
11. `sing-beatles/src/lib/audioService.ts` — singleton AudioContext + decoded buffer cache
12. `sing-beatles/scripts/preprocess.py` — how the Beatles pipeline turns MIDI + stems into phrase JSONs. **You are replacing this** with a different pipeline that works on any uploaded song.
13. `sing-beatles/supabase/schema.sql` — DB shape you will inherit
14. `sing-beatles/supabase/functions/feedback/*` — Claude-backed edge function
15. `demucs/app.py` — 140 lines, the entire stemming API we're adapting
16. `demucs/index.html` — the reference multi-stream player UI (for how stem playback feels with 4 synced `<audio>` elements)

## What's the same as Sing Beatles

- **Target platforms (v1)**: web only. The Expo project still targets RN so iOS/Android can be enabled later via EAS, but the deployed surface for v1 is the static web build on Render. This was an explicit launch-readiness call: web ships immediately and lands on a portfolio with no Apple/Google fees or store review. Reopen this decision once usage justifies a native build.
- **Retro 1-bit Mac aesthetic**: reuse `src/theme.ts` and the `FONTS` + `BORDER_1BIT` constants. Copy `Chrome.tsx`, `RetroButton.tsx`, `FontLoader.tsx` directly.
- **Auth**: Supabase anonymous sign-in. See `sing-beatles/src/lib/auth.ts` — copy it verbatim.
- **Session flow**: WelcomeScreen → PickerScreen → SessionScreen → TimelineScreen. Same state machine: `idle → listening → countdown → recording → done`.
- **Feedback**: same Claude edge function. Copy `supabase/functions/feedback/` directly.
- **Attempts storage**: same `attempts` table + Supabase Storage bucket + RLS policies.
- **Pitch analysis**: pitchy-based YIN on the attempt blob, compared against reference notes.
- **Piano roll + lyric strip + live waveform**: pixel-identical to Sing Beatles.

## What's different

### 1. Library is user-uploaded, not preprocessed

No more "pick a Beatles song" screen that lists 73 known tracks. Instead:

- **First-run state**: empty library, CTA to upload or import.
- **Upload screen**: drag-drop (web) or file picker (`expo-document-picker` on native). Accept `mp3/wav/m4a/flac/aac/ogg`.
- **Library screen**: list of user's own imported songs. Each song has processing status: `queued / stemming / analyzing / ready / error`.
- **Phrase picker**: once a song is ready, user picks which phrase/verse to practice. Phrases are auto-detected (see pipeline below).

### 2. The preprocessing pipeline is automated and server-side

Sing Beatles preprocesses locally using Rock Band MIDI files (which have phrase markers, note pitches, lyrics, and clean vocal stems baked in). You don't have that luxury here. You'll generate all of that from raw audio. Pipeline stages per uploaded song:

```
upload.mp3
  ↓  demucs (htdemucs)
drums.wav, bass.wav, vocals.wav, other.wav
  ↓  whisper-x (or faster-whisper + forced alignment)
word_timestamps.json    # per-word start/end + text
  ↓  pitch tracker (CREPE or pitchy on the vocals stem)
pitch_curve.json        # Hz at ~10ms hop
  ↓  note quantizer (cluster pitch curve into notes aligned to word boundaries)
notes.json              # [{start_ms, end_ms, pitch_midi, lyric}, ...]
  ↓  phrase detector (silence/gap-based segmentation on the vocals stem)
phrases.json            # [{start_ms, end_ms}, ...]
  ↓  ffmpeg slicing (per phrase) using the same CLIP_PAD_MS = 150 rule as sing-beatles
phrase_<slug>__vocals.ogg
phrase_<slug>__backing.ogg    # = mix of drums+bass+other for that slice
  ↓  upload sliced files to Supabase Storage; insert rows into phrases table
```

Output shape MUST match `sing-beatles/src/types/index.ts` (see `Phrase` and `MidiNote`). This way the SessionScreen is a one-file copy.

### 3. The stemming backend is a long-running service, not a script

Demucs on CPU takes 2–5 minutes per song. On an M1/M2 it's ~1 min. You need:

- **A hosted worker** that accepts uploads and runs the pipeline. Options, in order of preference:
  - **Modal** (`modal.com`) — best option, per-second GPU billing, trivially deploys a Python function with GPU. See "Hosting: Modal" below.
  - **Replicate** — hosted Demucs endpoint available; higher per-call cost but zero-ops. Fallback.
  - **Render background worker** — cheap but CPU-only; acceptable if you only run Demucs once per song.
- **A job record in Supabase** (`jobs` table) so the app can poll progress.
- **Client side**: upload file → POST to worker → poll `jobs` table → on `ready`, populate the phrases list.

### 4. No hourly-creativity-ping assumption

Sing Beatles ships a "practice every hour" hook. Don't port that. Sing Anything is a practice-on-demand tool first. The practice mode code (`sing-beatles/src/lib/practiceMode.ts`, `reminders.ts`, `onboarding.ts`) is optional — if you wire it, make it off-by-default.

## Architecture

```
┌─────────────────────────┐
│ React Native (Expo)     │
│  - iOS / Android / Web  │
│  - Upload screen        │
│  - Library screen       │
│  - Session screen (=    │
│    sing-beatles port)   │
└───────────┬─────────────┘
            │
            │  POST /upload  (file)
            │  GET  /job/:id
            ▼
┌─────────────────────────┐      ┌──────────────────────┐
│ Modal worker (Python)   │─────▶│ Supabase Storage     │
│  - demucs (htdemucs)    │      │  originals/          │
│  - whisperx or whisper  │      │  stems/              │
│  - pitch tracker        │      │  phrases/            │
│  - phrase detector      │      │  attempts/           │
│  - ffmpeg slicer        │      └──────────────────────┘
└───────────┬─────────────┘      ┌──────────────────────┐
            │                    │ Supabase Postgres    │
            └───────────────────▶│  jobs                │
                                 │  songs               │
                                 │  phrases             │
                                 │  attempts            │
                                 └──────────────────────┘
                                            ▲
                                            │
┌─────────────────────────┐                 │
│ Supabase Edge Function  │─────────────────┘
│  feedback (Claude)      │
└─────────────────────────┘
```

## Data model (Supabase)

Start from `sing-beatles/supabase/schema.sql` and add:

```sql
-- user-owned; one row per uploaded song
create table public.songs (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  slug          text not null,          -- user_id-scoped slug, not globally unique
  name          text not null,          -- file name or ID3 title
  artist        text,                   -- best-effort from ID3 or 'Unknown'
  duration_ms   int,
  original_path text not null,          -- storage: originals/<user_id>/<song_id>.mp3
  status        text not null default 'queued',   -- queued|stemming|analyzing|ready|error
  error         text,
  created_at    timestamptz not null default now(),
  unique (user_id, slug)
);

create index songs_user_created_idx on public.songs(user_id, created_at desc);

-- preserve sing-beatles phrases table shape, but add user_id scoping and make
-- song_id point to our new user-owned songs table
-- Keep all other columns (phrase_type, start_ms, end_ms, duration_ms, tempo_bpm,
-- lyric_text, notes jsonb, vocals_path, backing_path).

alter table public.phrases add column user_id uuid references auth.users(id) on delete cascade;

-- jobs table for pipeline progress (queryable from client)
create table public.jobs (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  song_id      uuid references public.songs(id) on delete cascade,
  stage        text not null,           -- upload|stemming|whisper|pitch|slicing|done|error
  progress     numeric,                 -- 0..1
  message      text,
  updated_at   timestamptz not null default now()
);

create index jobs_user_updated_idx on public.jobs(user_id, updated_at desc);
```

RLS: every table scoped to `auth.uid() = user_id`. Songs, phrases, attempts, jobs all owner-only. Storage buckets: `originals` private + owner-only, `phrases` private + owner-only, `attempts` private + owner-only (same pattern as sing-beatles).

## Hosting: Modal (recommended)

Modal is the path of least resistance for a hobby-scale GPU worker. Rough shape:

```python
# worker/app.py
import modal

image = (
    modal.Image.debian_slim()
    .apt_install("ffmpeg")
    .pip_install(
        "demucs",
        "whisperx",         # or "faster-whisper" + "whisper-timestamped"
        "crepe",            # or "pitchy" equivalent in Python
        "mido",
        "supabase",
        "numpy",
        "scipy",
    )
)

app = modal.App("sing-anything-worker")

@app.function(
    image=image,
    gpu="T4",               # sufficient for demucs + whisper-small
    timeout=900,
    secrets=[modal.Secret.from_name("supabase")],
)
def process_song(song_id: str, original_url: str) -> dict:
    # 1. download original
    # 2. demucs --out /tmp/stems <file>
    # 3. whisperx alignment on vocals.wav
    # 4. pitch track on vocals.wav (crepe)
    # 5. quantize pitch curve into notes anchored to word timestamps
    # 6. detect phrases from vocal silence (>400ms of no voicing)
    # 7. ffmpeg-slice vocals.wav and (drums+bass+other) mix per phrase
    # 8. upload slices to Supabase Storage
    # 9. insert phrase rows
    # 10. update job to done
    ...

@app.function(image=image, secrets=[modal.Secret.from_name("supabase")])
@modal.fastapi_endpoint(method="POST")
def upload(file: bytes):
    # write to Supabase Storage originals/
    # spawn process_song.remote(...)
    # return {job_id, song_id}
    ...
```

Deploy with `modal deploy worker/app.py`. The endpoint URL goes into `EXPO_PUBLIC_WORKER_URL`.

If the user pushes back on Modal: Replicate has a one-click demucs endpoint. Render CPU is the fallback — expect 3–5 min per song and a visible progress indicator.

## Mobile upload specifics

```
expo install expo-document-picker
```

```ts
// src/lib/upload.ts
import * as DocumentPicker from 'expo-document-picker';

export async function pickAudio() {
  const res = await DocumentPicker.getDocumentAsync({
    type: 'audio/*',
    copyToCacheDirectory: true,
  });
  if (res.canceled) return null;
  return res.assets[0]; // { uri, name, mimeType, size }
}
```

Web falls back to a standard `<input type="file" accept="audio/*" />` inside the same picker screen.

Upload strategy: use **Supabase resumable upload** (`tus`) for files over 10MB. Small files go direct. The app's upload screen must show a sensible progress bar — file uploads over cellular can be painful. After the file is in Supabase Storage, call the Modal endpoint with `{ song_id, original_url }`.

## Pipeline gotchas

1. **Phrase detection on a raw vocal stem is the hardest step.** A quick and reasonable approach: treat any gap of ≥400ms with RMS below -40dB as a phrase boundary. Cap phrase length at 15s; if a phrase runs longer, split on the next gap over 200ms. Also emit a "verse" cut (concatenation of 3–5 consecutive phrases, capped at 22s) so the UI's existing line/verse toggle works.

2. **Pitch quantization is fiddly.** Don't emit a MIDI note per pitch-curve sample. Instead: for each word's `[start_ms, end_ms]` window, take the median pitch over that window, quantize to nearest MIDI integer, emit one note. If a word spans a melisma (pitch changes by >2 semitones within the word), split into two notes at the point of change. This is a heuristic — good enough for a practice UI, not good enough for a transcription product.

3. **Whisper word timestamps are not exact.** whisperx is noticeably better than vanilla whisper because it does forced alignment with wav2vec. Use whisperx or faster-whisper with `word_timestamps=True`.

4. **Tempo**: no MIDI means no authoritative BPM. Either use `librosa.beat.beat_track` on the drums stem, or default to 120. The SessionScreen uses tempo to set count-in speed, so any reasonable guess is fine.

5. **Copy-left**: preprocess_all.py's CLIP_PAD_MS, slug pattern, ffmpeg Vorbis flags (`-q:a 6`), and meta JSON structure — copy these exactly. The schema match between the pipeline output and what SessionScreen expects is the load-bearing contract.

6. **User-uploaded content**: DO NOT add any "featured" or public song library. Each user sees only their own uploads. This dodges a host of licensing questions. Add a disclaimer on the upload screen: "Upload songs you own or have rights to practice with." That's the user's problem, not yours.

## Directory layout

```
sing-anything/
├── CLAUDE.md                       ← this file
├── README.md                       ← user-facing short version
├── package.json
├── app.json
├── App.tsx                         ← copy-adapt from sing-beatles
├── tsconfig.json
├── babel.config.js
├── assets/                         ← copy sing-beatles/assets fonts + icons
├── render.yaml                     ← static web deploy (optional)
├── src/
│   ├── theme.ts                    ← verbatim copy
│   ├── types/index.ts              ← extend with Song (user-owned) + Job
│   ├── components/
│   │   ├── Chrome.tsx              ← verbatim copy
│   │   ├── RetroButton.tsx         ← verbatim copy
│   │   ├── FontLoader.tsx          ← verbatim copy
│   │   ├── LyricStrip.tsx          ← verbatim copy
│   │   ├── PitchRibbon.tsx         ← verbatim copy
│   │   ├── WaveformCanvas.tsx      ← verbatim copy
│   │   └── UploadDropzone.tsx      ← NEW
│   ├── lib/
│   │   ├── supabase.ts             ← copy, swap env vars
│   │   ├── auth.ts                 ← verbatim copy
│   │   ├── audioService.ts         ← verbatim copy
│   │   ├── countIn.ts              ← verbatim copy
│   │   ├── recorder.ts             ← verbatim copy
│   │   ├── pitch.ts                ← verbatim copy
│   │   ├── feedback.ts             ← verbatim copy
│   │   ├── attempts.ts             ← copy, adapt phrase_id
│   │   ├── phrases.ts              ← copy, filter by current user
│   │   ├── songs.ts                ← NEW — list user's songs
│   │   ├── upload.ts               ← NEW — pick + upload + spawn job
│   │   └── jobs.ts                 ← NEW — subscribe to job progress
│   └── screens/
│       ├── WelcomeScreen.tsx       ← copy, adjust copy text
│       ├── UploadScreen.tsx        ← NEW — drag/drop or picker
│       ├── LibraryScreen.tsx       ← NEW — user's songs with status
│       ├── PickerScreen.tsx        ← copy, take songId param
│       ├── SessionScreen.tsx       ← verbatim copy (this is the payoff!)
│       └── TimelineScreen.tsx      ← verbatim copy
├── supabase/
│   ├── schema.sql                  ← extended from sing-beatles
│   └── functions/feedback/         ← verbatim copy
└── worker/
    ├── app.py                      ← Modal app (upload endpoint + pipeline)
    ├── pipeline/
    │   ├── stems.py                ← demucs wrapper
    │   ├── transcribe.py           ← whisperx wrapper
    │   ├── pitch.py                ← CREPE wrapper
    │   ├── phrases.py              ← silence-gap segmentation
    │   └── slice.py                ← ffmpeg phrase emitter
    └── requirements.txt
```

## Build order (roadmap)

Don't try to build all of this in one sitting. Suggested sequencing — each step should leave something demonstrable.

**Phase 1 — shell**
1. Scaffold Expo + TypeScript project (`npx create-expo-app sing-anything --template blank-typescript`).
2. Copy over theme, Chrome, RetroButton, FontLoader, assets, supabase client, auth.
3. Stand up WelcomeScreen + skeleton LibraryScreen (empty state only).
4. Run `npm run ios` and confirm the retro aesthetic renders on device.

**Phase 2 — Supabase**
5. Create a new Supabase project. Apply the extended schema.
6. Wire `ensureSignedIn` (anonymous auth) — copy verbatim.
7. Create `originals / phrases / attempts` buckets with owner-only RLS.
8. Deploy the `feedback` edge function.

**Phase 3 — backend pipeline, smoke test**
9. Stand up a trivial Modal function that just runs `demucs` on a file and writes outputs to Supabase Storage. Call it manually with a hardcoded URL to confirm auth, file I/O, and the round trip all work.
10. Layer in whisperx → pitch → phrase detection → slicing. At each layer, write outputs to a temp Supabase folder you can inspect.

**Phase 4 — upload flow**
11. UploadScreen with `expo-document-picker`, progress bar.
12. Write song row (status=`queued`) and original to `originals/<user_id>/<song_id>.mp3`.
13. Call Modal `upload` endpoint; poll `jobs` table (or subscribe via Supabase Realtime) to update UI status.

**Phase 5 — practice**
14. Copy SessionScreen verbatim. Port PickerScreen to accept a `songId` and list that song's phrases.
15. Practice one user-uploaded song end to end. Record an attempt. Confirm pitch analysis + Claude feedback work unchanged.

**Phase 6 — polish**
16. TimelineScreen (attempts history) — verbatim copy.
17. Error states per job stage.
18. Usage caps (optional): limit to N songs per user or N minutes of processing per day to keep Modal costs sane.

## Non-goals for v1

- No public song sharing, no "featured" songs, no cross-user discovery.
- No lyric editing after pipeline runs (the whisper transcript is the lyric, wrong or not).
- No key/pitch transposition controls.
- No metronome-only practice without a backing track.
- No multi-track stem player controls on the Session screen (Sing Beatles plays a fixed backing+vocals mix; don't add stem mute/solo in v1). The reference `demucs/index.html` has this UI — we're NOT porting it to Session. If the user eventually wants a stem player view, that's a separate post-v1 screen.

## Environment variables

```
EXPO_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
EXPO_PUBLIC_WORKER_URL=https://<username>--sing-anything-worker-upload.modal.run
```

Plus Modal secrets (service-side only, never in the app bundle):
```
SUPABASE_SERVICE_ROLE_KEY=...     # for server-side writes to storage and DB
SUPABASE_URL=...
```

## The UX contract (don't break this)

- User uploads a song and the app says "separating stems and finding phrases — this takes about 2 minutes". Progress bar. They can close the app and come back; processing continues server-side. Library screen shows status per song.
- When a song is ready, tapping it lands in the exact Sing Beatles picker → session → timeline flow. The experience inside a practice session should be indistinguishable from Sing Beatles.
- No login required. Anonymous auth means the first upload is one tap from the empty state.

## Questions to ask the user before building

Don't just start building. Confirm these:

1. **Worker hosting**: "I'm planning to use Modal for the Demucs/Whisper pipeline — it's per-second GPU billing and suits this shape of workload. OK, or do you prefer Replicate / your own box / something else?"
2. **Supabase project**: "Should I reuse the `sing-beatles` Supabase project with scoped tables, or create a new one?"
3. **Target platforms**: "You mentioned iOS and Android — is web a nice-to-have, or skip it entirely? (Sing Beatles is web-first; Sing Anything will work cross-platform if you want both.)"
4. **v1 scope**: "Does the Phase 1–5 sequence above match your priorities? Any phase I can defer to save time?"

Once you have answers, propose a Phase 1 plan and start scaffolding.

## Related global instructions

The user has personal instructions in `~/.claude/CLAUDE.md` about launching headless agents (Codex, Gemini). Those don't affect the build itself but may matter if you want to run a Trident code review later.

Today's date is 2026-04-24.
