# Sing All The Time

Upload any song. The app stems it with [Demucs](https://github.com/facebookresearch/demucs), transcribes the lyrics with [WhisperX](https://github.com/m-bain/whisperX), tracks pitch with [torchcrepe](https://github.com/maxrmorrison/torchcrepe), slices it into phrases, and drops you into a karaoke practice loop with live pitch feedback and a one-line written takeaway per take.

Live at: <https://sing-anything.onrender.com> *(set this once Render is live)*

## What it does

1. You drop in an audio file or paste a YouTube / SoundCloud / Bandcamp URL.
2. A Modal GPU worker stems vocals out of the mix, transcribes them with word-level timestamps, tracks pitch, and segments the song into sing-able phrases (≤15 s lines, ≤22 s verses).
3. You pick a phrase. The app plays a count-in at the song's tempo, scrolls a piano-roll of the target notes synced to the lyrics, records you, and shows your pitch curve overlaid on the target.
4. A Supabase edge function reads the pitch comparison and writes one warm sentence of feedback per take.

## Stack

| Layer | Tech |
| --- | --- |
| Client | Expo (React Native + web), TypeScript |
| Auth | Supabase magic links |
| Storage / DB | Supabase Postgres + Storage, RLS scoped per user |
| GPU pipeline | Modal — Demucs (htdemucs) → WhisperX → torchcrepe → ffmpeg slicer |
| URL ingest | yt-dlp behind an IPRoyal residential proxy |
| Lyrics fallback | LRCLIB → Anthropic API |
| Feedback | Anthropic API via Supabase edge function |
| Hosting | Render (web), Modal (worker) |

## Architecture

```
React Native client (Expo)
        │
        │ 1. Pick file / paste URL
        ▼
Supabase Storage  ── 2. Insert song row (status=queued) ──▶  Supabase Postgres
        │                                                    (RLS: owner-only)
        │ 3. POST /upload
        ▼
Modal worker (T4 GPU, 1800 s timeout)
  ├── yt-dlp (URL ingest)
  ├── Demucs htdemucs (stems)
  ├── WhisperX (lyrics + word timestamps)
  ├── torchcrepe (pitch curve)
  ├── note quantizer (curve → MIDI per word)
  ├── phrase detector (silence-gap segmentation)
  └── ffmpeg slicer (per-phrase vocals + backing mix)
        │
        ▼
Supabase Storage / phrases  +  phrases table rows  +  jobs.status = done
        │
        ▼
Client polls jobs (Realtime) → Library row flips to "ready" → Practice screen
```

## Cost (rough)

- Modal T4: ~$0.35/hr. A typical 3-min song processes in ~90 s warm, ~3 min cold, so **roughly $0.01–0.02 per upload**.
- Supabase free tier covers <100 active users; storage is the first thing to spill (originals ~3 MB/song, slices ~5 MB/song).
- Render static web: free.

For a portfolio demo with quotas (3 in-flight jobs, 10 songs/day per user), monthly cost lands around **$5–15** even with steady traffic.

## Running it yourself

You need a Supabase project, a Modal account, and an Anthropic API key.

### 1. Supabase

```bash
# Create a project at https://supabase.com/dashboard
# Then push the schema from this repo:
cd supabase
supabase link --project-ref <your-ref>
supabase db push
supabase functions deploy feedback
```

Storage buckets needed (private, owner-only RLS):
- `originals` — raw uploads
- `phrases` — sliced vocals/backing per phrase, plus derived artifacts
- `attempts` — user recordings

### 2. Modal worker

```bash
cd worker
modal secret create supabase \
  SUPABASE_URL=https://<ref>.supabase.co \
  SUPABASE_ANON_KEY=<anon-key> \
  SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
  DEMO_USER_ID=<demo-account-uuid>     # optional, exempts demo from quotas

# IPRoyal residential proxy for YouTube ingest. Datacenter IPs trip
# YouTube's bot wall; a residential exit hop sails past it.
modal secret create iproyal PROXY_URL=http://user:pass@geo.iproyal.com:12321

# LRCLIB is free; ANTHROPIC_API_KEY is for the lyrics-fallback Haiku call.
modal secret create lyrics-providers \
  LRCLIB_URL=https://lrclib.net/api \
  ANTHROPIC_API_KEY=sk-ant-...

modal deploy app.py
# Note the api endpoint URL it prints — that goes into EXPO_PUBLIC_WORKER_URL.
```

### 3. Client

```bash
cp .env.example .env
# Fill in EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY,
#         EXPO_PUBLIC_WORKER_URL.

npm install
npm run web        # localhost:8081
# or
npm run ios        # native iOS build
```

### 4. Web deploy (Render)

`render.yaml` in the repo root configures a static-site build. Connect the repo to Render, set the three env vars (the file marks them `sync: false`), deploy. Render runs `npm ci && npx expo export -p web` and serves `./dist`.

## Environment variables

### Client (Expo, baked into the bundle — must be public-safe)

| Var | Purpose |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Anon key (RLS gates everything sensitive) |
| `EXPO_PUBLIC_WORKER_URL` | Modal `api` endpoint URL |
| `EXPO_PUBLIC_DEBUG_PASSWORD` | Optional. Enables the `#/debug` auto-login route. |

### Worker (Modal secrets, server-side only)

| Secret | Vars |
| --- | --- |
| `supabase` | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Optional: `DEMO_USER_ID`. |
| `iproyal` | `PROXY_URL` |
| `lyrics-providers` | `LRCLIB_URL`, `ANTHROPIC_API_KEY` |

## Limits

To keep the GPU bill predictable, the worker enforces:

- 30 MB / file (client) and 100 MB / file (worker)
- 10 minutes max audio duration
- 3 in-flight jobs per user
- 10 uploads per user per 24 h
- 1800 s hard timeout per job; stale-heartbeat jobs get reaped after 10 min

## Privacy / terms

Anonymous uploads aren't supported — sign-in is required so each user's library is scoped to their own auth UID. RLS policies on every table and bucket enforce this server-side. Uploaded audio is never shared between users; deleting a song removes the original, all slices, and all your recordings.

The web app links to `/privacy` and `/terms` from the sign-in screen and the upload screen.

**Don't upload songs you don't have rights to practice with.** That's on you.

## Repo layout

```
sing-anything/
├── App.tsx                   # navigation shell + auth gate
├── src/
│   ├── screens/              # Welcome / Library / Upload / Picker / Session …
│   ├── components/           # PitchRibbon, LyricStrip, WaveformCanvas, Chrome
│   ├── lib/                  # supabase, auth, recorder, pitch, feedback, jobs, upload
│   └── theme.ts              # 1-bit retro palette, fonts
├── supabase/
│   ├── migrations/           # schema + RLS
│   └── functions/feedback/   # written-feedback edge function
├── worker/
│   ├── app.py                # Modal app: /upload, /upload_youtube, process_song
│   └── pipeline/             # stems, transcribe, pitch, notes, phrases, slice, …
└── render.yaml               # static-web deploy config
```

## Sibling projects

Built from two reference projects in the same parent folder:

- [`../sing-beatles/`](../sing-beatles/) — the practice-UI we're cloning. Same retro shell, same session loop, same pitch feedback. Sing Anything inherits the UX; the difference is the song library is user-uploaded instead of a fixed Beatles set.
- [`../demucs/`](../demucs/) — a tiny Flask reference app that wraps Meta's Demucs.

## License

MIT.
