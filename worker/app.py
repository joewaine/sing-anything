"""Modal worker for Sing Anything.

End-to-end pipeline: download -> demucs -> whisperx -> torchcrepe -> note
quantize -> phrase detect -> ffmpeg slice -> Supabase upload + DB insert.

Smoke-test (no DB writes):
    modal run worker/app.py::smoke_full \
      --original-url "<signed supabase URL>" \
      --song-id "smoke-$(date +%s)"

Real run (caller supplies user_id + song_id from an inserted songs row):
    modal run worker/app.py::run \
      --original-url "..." --song-id "<uuid>" --user-id "<uuid>" [--job-id "<uuid>"]
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen

import modal

# ────────────────────────────────────────────────────────────────────────────
# Image
#
# Layering strategy keeps the slow demucs install cached across iterations.
# torchcodec is the fix for torchaudio>=2.11 save(). whisperx + torchcrepe +
# librosa land in a later layer so image rebuilds only touch that layer when
# we bump their versions.
# ────────────────────────────────────────────────────────────────────────────
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "demucs==4.0.1",
        "supabase==2.11.0",
    )
    .pip_install("torchcodec")
    .pip_install(
        "whisperx",
        "torchcrepe",
        "librosa==0.10.2",
        "soundfile==0.12.1",
    )
    # HTTP layer for the /upload endpoint (FastAPI + httpx for JWT verify).
    .pip_install(
        "fastapi[standard]",
        "httpx",
    )
    # yt-dlp for YouTube audio ingest (separate layer so we can bump it
    # independently — yt-dlp updates frequently to track YouTube changes).
    # NOTE: We tested the bgutil-ytdlp-pot-provider plugin (Proof-of-Origin
    # tokens via Node helper) and confirmed it loads correctly, but
    # YouTube's cloud-IP block fires *before* the PO token is checked,
    # so it didn't help. Reverted to vanilla yt-dlp; cookies or a
    # residential proxy are the only realistic workarounds for YouTube on
    # Modal IPs.
    .pip_install("yt-dlp")
    # Demucs weights live under ~/.cache/torch; that path is a Modal Volume
    # at runtime (see `torch_cache`), so baking them into the image would be
    # shadowed. First cold start populates the volume once and every
    # subsequent cold start reuses it.
    # Ship the local `pipeline/` subpackage into the container. Cheap (no
    # rebuild); each iteration just re-uploads the edited .py files.
    .add_local_python_source("pipeline")
)

# Model downloads (Whisper large-v3, wav2vec2 aligners, Demucs htdemucs)
# are big and redownloaded on every cold start unless we mount persistent
# volumes. HuggingFace caches under ~/.cache/huggingface; Demucs + most
# torchaudio assets cache under ~/.cache/torch.
hf_cache = modal.Volume.from_name("sing-anything-hf-cache", create_if_missing=True)
torch_cache = modal.Volume.from_name("sing-anything-torch-cache", create_if_missing=True)

MODEL_VOLUMES = {
    "/root/.cache/huggingface": hf_cache,
    "/root/.cache/torch": torch_cache,
}

app = modal.App("sing-anything-worker", image=image)


MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024  # 100 MB — matches the client 30 MB
                                         # cap with headroom; stops any
                                         # signed URL from OOM-ing the container.


def _download(url: str, dest: Path) -> None:
    req = Request(url, headers={"User-Agent": "sing-anything-worker/0.1"})
    total = 0
    with urlopen(req) as resp, dest.open("wb") as out:
        while chunk := resp.read(1 << 20):
            total += len(chunk)
            if total > MAX_DOWNLOAD_BYTES:
                raise RuntimeError(
                    f"download exceeds {MAX_DOWNLOAD_BYTES:,} bytes; aborting"
                )
            out.write(chunk)


class YoutubeBlockedError(RuntimeError):
    """YouTube refused the download (bot detection / age-gate / region-lock).
    Carries a user-friendly message for the songs.error column."""


def _yt_download(url: str, dest: Path) -> dict:
    """Extract the best audio-only stream via yt-dlp and save as mp3.

    Works for anything yt-dlp supports (YouTube, SoundCloud, Vimeo,
    Bandcamp, direct audio URLs, …). Returns metadata dict so the caller
    can populate the songs row.

    Raises YoutubeBlockedError with a friendly message when YouTube
    specifically refuses (cloud-IP bot gate). Other errors bubble up.
    """
    import yt_dlp

    out_tmpl = str(dest.parent / "yt_tmp.%(ext)s")
    opts = {
        "format": "bestaudio/best",
        "outtmpl": out_tmpl,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }
    # YouTube only: route through IPRoyal residential proxy (env var
    # PROXY_URL injected via the `iproyal` Modal secret). Modal's
    # datacenter IPs trip YouTube's bot wall regardless of player client
    # or PO tokens — a residential exit hop sails past it. Other sources
    # (SoundCloud, Bandcamp, direct mp3) skip the proxy to save bandwidth.
    is_youtube = (
        "youtube.com" in url
        or "youtu.be" in url
        or "music.youtube.com" in url
    )
    if is_youtube:
        proxy_url = os.environ.get("PROXY_URL")
        if proxy_url:
            opts["proxy"] = proxy_url
            print(f"[_yt_download] routing YouTube via residential proxy")
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as e:
        msg = str(e)
        if "Sign in to confirm" in msg or "not a bot" in msg:
            raise YoutubeBlockedError(
                "YouTube blocked this download from the worker's IP. "
                "Try a direct audio URL (SoundCloud, Bandcamp, .mp3) — "
                "those don't have the same bot check."
            ) from e
        raise

    produced = dest.parent / "yt_tmp.mp3"
    if not produced.exists():
        raise RuntimeError("yt-dlp produced no mp3 output")
    produced.replace(dest)

    size = dest.stat().st_size
    if size > MAX_DOWNLOAD_BYTES:
        raise RuntimeError(
            f"yt-dlp output {size:,} bytes > {MAX_DOWNLOAD_BYTES:,} cap"
        )

    return {
        "title": (info or {}).get("title"),
        "uploader": (info or {}).get("uploader") or (info or {}).get("channel"),
        "duration": (info or {}).get("duration"),
    }


@app.function(
    gpu="T4",
    timeout=1800,
    secrets=[modal.Secret.from_name("supabase"), modal.Secret.from_name("iproyal")],
    volumes=MODEL_VOLUMES,
)
def demucs_split(original_url: str, song_id: str) -> dict:
    """Phase-3-step-9 smoke: just download + demucs + upload 4 stems."""
    from supabase import create_client

    from pipeline.stems import run_demucs

    supabase = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        original = tmp_dir / "original.mp3"
        print(f"[demucs_split] downloading {original_url}")
        _download(original_url, original)
        print(f"[demucs_split] got {original.stat().st_size:,} bytes")

        stem_dir = run_demucs(original, tmp_dir / "out")
        uploaded: dict[str, str] = {}
        for name in ("drums", "bass", "vocals", "other"):
            src = stem_dir / f"{name}.wav"
            dest = f"stems/{song_id}/{name}.wav"
            print(f"[demucs_split] uploading {name}.wav -> phrases/{dest}")
            supabase.storage.from_("phrases").upload(
                path=dest,
                file=src.read_bytes(),
                file_options={"content-type": "audio/wav", "upsert": "true"},
            )
            uploaded[name] = dest
    return {"song_id": song_id, "bucket": "phrases", "stems": uploaded}


@app.function(
    gpu="T4",
    timeout=1800,
    secrets=[modal.Secret.from_name("supabase"), modal.Secret.from_name("iproyal")],
    volumes=MODEL_VOLUMES,
)
def process_song(
    song_id: str,
    original_url: str | None = None,
    youtube_url: str | None = None,
    user_id: str | None = None,
    job_id: str | None = None,
) -> dict:
    """Full end-to-end pipeline for one uploaded song.

    Provide exactly one of `original_url` (signed Supabase URL for a
    pre-uploaded file) or `youtube_url`. For YouTube inputs, the worker
    downloads via yt-dlp, mirrors the mp3 into the originals bucket, and
    updates the songs row with title/artist from the video metadata.

    If `user_id` is set, inserts phrase rows + flips songs.status to 'ready'.
    If `user_id` is None (smoke mode), uploads phrase slices to a `smoke/`
    prefix so they can be inspected in the Storage dashboard, but skips DB
    writes.
    """
    from supabase import create_client

    from pipeline.lyrics_verify import verify_lyrics
    from pipeline.notes import quantize_notes
    from pipeline.phrases import detect_phrases
    from pipeline.pitch import pitch_curve
    from pipeline.slice import slice_phrase, upload_slice
    from pipeline.stems import mix_backing, run_demucs
    from pipeline.transcribe import transcribe_words

    sb = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )

    def stage(name: str, progress: float, message: str = "") -> None:
        print(f"[stage {name} {progress:.2f}] {message}")
        if not job_id:
            return
        try:
            sb.table("jobs").update({
                "stage": name,
                "progress": progress,
                "message": message,
            }).eq("id", job_id).execute()
        except Exception as e:
            print(f"[stage] jobs update failed: {e}")

    if not original_url and not youtube_url:
        raise ValueError("process_song needs either original_url or youtube_url")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        original = tmp_dir / "original.mp3"

        if youtube_url:
            stage("upload", 0.05, "downloading from URL")
            try:
                yt_info = _yt_download(youtube_url, original)
            except YoutubeBlockedError as e:
                msg = str(e)
                print(f"[process_song] yt-dlp blocked: {msg}")
                stage("error", 0.0, msg)
                if user_id:
                    sb.table("songs").update({
                        "status": "error", "error": msg,
                    }).eq("id", song_id).execute()
                return {"error": msg}
            except Exception as e:
                msg = f"URL download failed: {e}"
                print(f"[process_song] {msg}")
                stage("error", 0.0, msg)
                if user_id:
                    sb.table("songs").update({
                        "status": "error", "error": msg,
                    }).eq("id", song_id).execute()
                return {"error": msg}
            print(f"[process_song] yt-dlp title={yt_info.get('title')!r}")

            if user_id:
                # Mirror the downloaded audio into the originals bucket so the
                # song has a real file backing it (retakes, re-processing,
                # deletes all work the same as for file uploads).
                mirror_path = f"{user_id}/{song_id}.mp3"
                sb.storage.from_("originals").upload(
                    path=mirror_path,
                    file=original.read_bytes(),
                    file_options={"content-type": "audio/mpeg", "upsert": "true"},
                )
                updates: dict = {"original_path": mirror_path}
                if yt_info.get("title"):
                    updates["name"] = yt_info["title"]
                if yt_info.get("uploader"):
                    updates["artist"] = yt_info["uploader"]
                sb.table("songs").update(updates).eq("id", song_id).execute()
        else:
            stage("upload", 0.05, "downloading original")
            _download(original_url, original)
        print(f"[process_song] original = {original.stat().st_size:,} bytes")

        # Safety cap: reject anything over 10 minutes so a runaway podcast
        # upload can't silently eat ~$5 of GPU time.
        import json as _json
        import subprocess
        probe = subprocess.check_output([
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "json",
            str(original),
        ])
        duration_s = float(_json.loads(probe)["format"]["duration"])
        print(f"[process_song] duration = {duration_s:.1f}s")
        if duration_s > 600:
            msg = f"song is {int(duration_s)}s (>10 min cap)"
            stage("error", 0.0, msg)
            if user_id:
                sb.table("songs").update({
                    "status": "error", "error": msg,
                    "duration_ms": int(duration_s * 1000),
                }).eq("id", song_id).execute()
            return {"error": msg}
        if user_id:
            sb.table("songs").update({
                "duration_ms": int(duration_s * 1000),
                "status": "stemming",
            }).eq("id", song_id).execute()

        stage("stemming", 0.15, "demucs htdemucs")
        stem_dir = run_demucs(original, tmp_dir / "out")
        vocals = stem_dir / "vocals.wav"
        drums = stem_dir / "drums.wav"

        backing = tmp_dir / "backing.wav"
        mix_backing(stem_dir, backing)

        stage("whisper", 0.40, "whisperx large-v3 + wav2vec2 align")
        language, words = transcribe_words(vocals)
        print(f"[process_song] language={language} words={len(words)}")

        # Best-effort lyric correction. Looks up song on LRCLIB (free, open),
        # falls back to Claude Sonnet if ANTHROPIC_API_KEY is set. Either
        # preserves whisper's timestamps, only changes word text. If both
        # fail (obscure song), whisper's raw output is kept.
        if words:
            stage("whisper", 0.50, "verifying lyrics")
            song_name = None
            song_artist = None
            if user_id:
                try:
                    song_row = (
                        sb.table("songs")
                        .select("name, artist")
                        .eq("id", song_id)
                        .single()
                        .execute()
                    )
                    song_name = (song_row.data or {}).get("name")
                    song_artist = (song_row.data or {}).get("artist")
                except Exception as e:
                    print(f"[process_song] song lookup failed: {e}")
            words, lyrics_source = verify_lyrics(words, song_name, song_artist)
            print(f"[process_song] lyrics source: {lyrics_source}")

        stage("pitch", 0.60, "torchcrepe full model")
        pitch = pitch_curve(vocals)

        stage("pitch", 0.70, "quantizing notes per word")
        notes = quantize_notes(pitch, words)
        print(f"[process_song] notes={len(notes)}")

        stage("slicing", 0.80, "detecting phrases")
        phrases = detect_phrases(vocals, notes, words, drums_path=drums)
        n_line = sum(1 for p in phrases if p["phrase_type"] == "line")
        n_verse = sum(1 for p in phrases if p["phrase_type"] == "verse")
        print(f"[process_song] phrases: line={n_line} verse={n_verse}")

        stage("slicing", 0.90, f"slicing + uploading {len(phrases)} clips")
        slices_dir = tmp_dir / "slices"
        slices_dir.mkdir()
        owner = user_id or "smoke"

        # Parallelize: ffmpeg is subprocess-bound (releases the GIL) and
        # Supabase uploads are I/O bound, so threading lets us overlap
        # otherwise-serial work instead of letting the GPU container rent
        # idle time while we loop. Each worker gets its OWN supabase client
        # to avoid httpx connection-pool contention across threads (shared
        # httpx.Client pool dropped connections under 8-wide concurrency).
        from concurrent.futures import ThreadPoolExecutor

        def _make_client():
            return create_client(
                os.environ["SUPABASE_URL"],
                os.environ["SUPABASE_SERVICE_ROLE_KEY"],
            )

        def _slice_and_upload_one(pair: tuple[int, dict]) -> dict:
            i, p = pair
            sliced = slice_phrase(vocals, backing, p, song_id, i, slices_dir)
            return upload_slice(_make_client(), owner, song_id, sliced)

        workers = min(len(phrases) or 1, 4)
        with ThreadPoolExecutor(max_workers=workers) as ex:
            results = list(ex.map(_slice_and_upload_one, enumerate(phrases)))

        if user_id:
            stage("slicing", 0.95, "inserting phrase rows + marking song ready")
            rows = [{
                "song_id": song_id,
                "user_id": user_id,
                "slug": r["slug"],
                "phrase_type": r["phrase_type"],
                "start_ms": r["start_ms"],
                "end_ms": r["end_ms"],
                "duration_ms": r["duration_ms"],
                "tempo_bpm": r["tempo_bpm"],
                "lyric_text": r["lyric_text"],
                "notes": r["notes"],
                "vocals_path": r["vocals_path"],
                "backing_path": r["backing_path"],
            } for r in results]
            if rows:
                sb.table("phrases").insert(rows).execute()
            sb.table("songs").update({"status": "ready"}).eq("id", song_id).execute()

        stage("done", 1.0, f"{len(results)} phrases ready")

        return {
            "song_id": song_id,
            "language": language,
            "words": len(words),
            "notes_total": len(notes),
            "phrases_total": len(results),
            "phrases_by_type": {"line": n_line, "verse": n_verse},
        }


@app.function(
    secrets=[modal.Secret.from_name("supabase"), modal.Secret.from_name("iproyal")],
    timeout=120,
    min_containers=0,
)
@modal.asgi_app()
def api():
    """FastAPI endpoint that the client calls after uploading to Storage.

    Contract: POST /upload { song_id } + Authorization: Bearer <user JWT>
              → { job_id }

    The endpoint verifies the caller's JWT against Supabase, confirms they
    own the referenced song row, issues a signed URL for the original, and
    spawns `process_song` with a fresh jobs row.
    """
    import httpx
    from fastapi import FastAPI, Header, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from supabase import create_client

    SUPABASE_URL = os.environ["SUPABASE_URL"]
    ANON_KEY = os.environ["SUPABASE_ANON_KEY"]
    SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

    web = FastAPI(title="sing-anything-worker")
    web.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def _verify_user(authorization: str | None) -> str:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "missing Authorization")
        r = httpx.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={"Authorization": authorization, "apikey": ANON_KEY},
            timeout=5.0,
        )
        if r.status_code != 200:
            raise HTTPException(401, "invalid token")
        return r.json()["id"]

    @web.post("/upload")
    def upload(body: dict, authorization: str | None = Header(None)):
        user_id = _verify_user(authorization)
        song_id = body.get("song_id")
        if not song_id:
            raise HTTPException(400, "song_id required")

        sb = create_client(SUPABASE_URL, SERVICE_KEY)

        song = sb.table("songs").select("id, user_id, original_path").eq("id", song_id).single().execute()
        if not song.data or song.data["user_id"] != user_id:
            raise HTTPException(404, "song not found")

        # Idempotency: if a job for this song is already in flight (queued
        # or any non-terminal stage), return it instead of spawning another
        # worker. Protects against double-click uploads, retries, etc.
        existing = (
            sb.table("jobs")
            .select("id, stage")
            .eq("song_id", song_id)
            .not_.in_("stage", ["done", "error"])
            .order("updated_at", desc=True)
            .limit(1)
            .execute()
        )
        if existing.data:
            return {"job_id": existing.data[0]["id"], "already_running": True}

        signed = sb.storage.from_("originals").create_signed_url(
            path=song.data["original_path"], expires_in=3600,
        )
        signed_url = signed.get("signedURL") or signed.get("signed_url") or ""
        if signed_url.startswith("/"):
            signed_url = f"{SUPABASE_URL}/storage/v1{signed_url}"

        job = sb.table("jobs").insert({
            "user_id": user_id,
            "song_id": song_id,
            "stage": "queued",
            "progress": 0,
            "message": "queued",
        }).execute()
        job_id = job.data[0]["id"]

        process_song.spawn(
            original_url=signed_url,
            song_id=song_id,
            user_id=user_id,
            job_id=job_id,
        )

        return {"job_id": job_id}

    @web.post("/upload_youtube")
    def upload_youtube(body: dict, authorization: str | None = Header(None)):
        """YouTube ingest — caller has already inserted a placeholder songs
        row; worker fetches audio via yt-dlp, mirrors into storage, updates
        the row, then runs the normal pipeline."""
        user_id = _verify_user(authorization)
        song_id = body.get("song_id")
        youtube_url = body.get("youtube_url")
        if not song_id or not youtube_url:
            raise HTTPException(400, "song_id and youtube_url required")

        sb = create_client(SUPABASE_URL, SERVICE_KEY)

        song = (
            sb.table("songs")
            .select("id, user_id")
            .eq("id", song_id)
            .single()
            .execute()
        )
        if not song.data or song.data["user_id"] != user_id:
            raise HTTPException(404, "song not found")

        existing = (
            sb.table("jobs")
            .select("id, stage")
            .eq("song_id", song_id)
            .not_.in_("stage", ["done", "error"])
            .order("updated_at", desc=True)
            .limit(1)
            .execute()
        )
        if existing.data:
            return {"job_id": existing.data[0]["id"], "already_running": True}

        job = sb.table("jobs").insert({
            "user_id": user_id,
            "song_id": song_id,
            "stage": "queued",
            "progress": 0,
            "message": "queued (YouTube)",
        }).execute()
        job_id = job.data[0]["id"]

        process_song.spawn(
            song_id=song_id,
            youtube_url=youtube_url,
            user_id=user_id,
            job_id=job_id,
        )

        return {"job_id": job_id}

    return web


@app.function(
    timeout=120,
    secrets=[modal.Secret.from_name("supabase"), modal.Secret.from_name("iproyal")],
    volumes=MODEL_VOLUMES,
)
def yt_smoke(youtube_url: str) -> dict:
    """No-pipeline yt-dlp smoke. Just downloads to /tmp and returns metadata.
    Useful for confirming PO Tokens / cookies / proxy work without running
    a full GPU pipeline. Returns the title + size on success, or error on
    failure.
    """
    import tempfile
    import traceback

    try:
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "yt_smoke.mp3"
            info = _yt_download(youtube_url, dest)
            return {
                "ok": True,
                "title": info.get("title"),
                "uploader": info.get("uploader"),
                "duration": info.get("duration"),
                "bytes": dest.stat().st_size,
            }
    except YoutubeBlockedError as e:
        return {"ok": False, "blocked": True, "error": str(e)}
    except Exception as e:
        return {
            "ok": False,
            "error": f"{type(e).__name__}: {e}",
            "traceback": traceback.format_exc(),
        }


@app.local_entrypoint()
def yt_test(youtube_url: str) -> None:
    """Run: modal run worker/app.py::yt_test --youtube-url <URL>"""
    import json as _json
    print(_json.dumps(yt_smoke.remote(youtube_url=youtube_url), indent=2)[:1500])


@app.function(secrets=[modal.Secret.from_name("iproyal")], timeout=30)
def check_proxy_ip() -> dict:
    """Verify the residential proxy is actually changing our exit IP.
    Returns IP-as-seen-by-the-internet via the proxy AND without it."""
    import os
    import urllib.request
    import json as _json

    proxy_url = os.environ.get("PROXY_URL")
    out: dict = {"proxy_url_set": bool(proxy_url)}

    def fetch_ip(handler=None) -> str:
        opener = urllib.request.build_opener(handler) if handler else urllib.request.build_opener()
        with opener.open("https://api.ipify.org?format=json", timeout=15) as r:
            return _json.loads(r.read())["ip"]

    try:
        out["direct_ip"] = fetch_ip()
    except Exception as e:
        out["direct_ip_error"] = str(e)

    if proxy_url:
        try:
            handler = urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
            out["proxy_ip"] = fetch_ip(handler)
        except Exception as e:
            out["proxy_ip_error"] = str(e)
    return out


@app.local_entrypoint()
def proxy_check() -> None:
    import json as _json
    print(_json.dumps(check_proxy_ip.remote(), indent=2))


@app.local_entrypoint()
def smoke(original_url: str, song_id: str = "smoke") -> None:
    """Demucs-only smoke (Phase 3 step 9)."""
    print(demucs_split.remote(original_url=original_url, song_id=song_id))


@app.local_entrypoint()
def smoke_full(original_url: str, song_id: str = "smoke-full") -> None:
    """Full pipeline, smoke mode (no DB writes)."""
    print(process_song.remote(original_url=original_url, song_id=song_id, user_id=None))


@app.local_entrypoint()
def run(
    original_url: str,
    song_id: str,
    user_id: str,
    job_id: str | None = None,
) -> None:
    """Full pipeline end-to-end with DB inserts — the real production path."""
    print(process_song.remote(
        original_url=original_url, song_id=song_id, user_id=user_id, job_id=job_id
    ))
