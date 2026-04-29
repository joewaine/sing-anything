"""Multimodal ASR fallback using Gemini 3 Pro.

When LRCLIB doesn't have the song and Claude doesn't recognize the title,
this is the last-resort lyric source — feed the demucs vocals stem
directly into a multimodal LLM and ask it to transcribe the lyrics.

Why Gemini specifically: Gemini 3 Pro accepts audio natively (as base64
inline data) and is a strong cross-lingual transcriber. It also brings
song-knowledge priors that pure ASR doesn't — when it recognizes the
song, the transcription quality jumps because it can disambiguate
mumbled words against what it knows the lyric SHOULD be.

Returns plain text (one line per song line). The caller pipes this
through the same _align_canonical machinery used for LRCLIB+Claude
results, so words whisper missed get inserted with interpolated
timestamps.

Cost: ~$0.05-0.20 per song depending on length; only fires for tracks
that no other source could resolve, so total spend stays bounded.
"""

from __future__ import annotations

import base64
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

GEMINI_ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-3-pro-preview:generateContent"
)

# Inline-data size cap. Gemini accepts up to ~20MB base64-encoded inline
# audio; we leave headroom for the surrounding JSON and use a generous
# encoding. A 10-minute vocal stem at 64kbps mono MP3 is ~4.8MB raw,
# ~6.4MB base64 — safely under.
MAX_INLINE_MB = 18

_LYRICS_PROMPT = (
    "Transcribe the song lyrics from the attached audio (a vocals-only "
    "stem from a song). Return only the lyrics as plain text — one song "
    "line per text line. No timestamps, no section markers like "
    "[Verse]/[Chorus], no commentary. If you recognize the song, use the "
    "canonical published lyrics rather than literal phonetic guesses, "
    "but keep the line breaks where the singer actually pauses. If the "
    "audio has no intelligible vocals at all, respond with the literal "
    "token UNKNOWN and nothing else."
)


def _to_mp3(wav_path: Path) -> Optional[Path]:
    """Re-encode the vocals stem as 64kbps mono MP3 for upload. The
    vocals were already extracted from the mix at 44.1kHz; downsampling
    to 22.05kHz mono at 64kbps is plenty for ASR — pitch + diction
    survive cleanly while we cut the wire payload by ~10x.

    Returns the path to a temp .mp3 file (caller is responsible for
    cleanup via the parent NamedTemporaryFile / TemporaryDirectory) or
    None on ffmpeg failure.
    """
    out = wav_path.with_suffix(".gemini.mp3")
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", str(wav_path),
                "-ac", "1",                # mono
                "-ar", "22050",            # 22.05kHz — half of 44.1, plenty for vocals
                "-codec:a", "libmp3lame",
                "-b:a", "64k",
                str(out),
            ],
            check=True,
            timeout=120,
        )
        return out
    except subprocess.CalledProcessError as e:
        print(f"[audio_asr] ffmpeg encode failed: {e}")
        return None
    except subprocess.TimeoutExpired:
        print("[audio_asr] ffmpeg encode timed out")
        return None


def gemini_lyrics(vocals_path: Path) -> Optional[str]:
    """Run Gemini 3 Pro on the demucs vocals stem, return plain-text
    lyrics. Returns None when GEMINI_API_KEY is unset, the encode
    fails, the audio is too large, or Gemini returns UNKNOWN / errors.

    The output is intentionally plain (no LRC, no timestamps) — the
    caller threads it through `_align_canonical` for word-level
    timestamp alignment against the existing whisper transcription.
    """
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get(
        "GOOGLE_API_KEY"
    )
    if not api_key:
        print("[audio_asr] GEMINI_API_KEY not set; skipping audio ASR")
        return None

    if not vocals_path.exists():
        print(f"[audio_asr] vocals path missing: {vocals_path}")
        return None

    with tempfile.TemporaryDirectory() as tmp:
        # Stage the mp3 inside a temp dir so its parent goes away on
        # exit even if we leave early. _to_mp3 writes alongside the wav
        # path's parent, but here we'd rather isolate the artifact.
        tmp_dir = Path(tmp)
        local_wav = tmp_dir / vocals_path.name
        # Symlink to avoid copying a large WAV into temp; falls back to
        # a real copy if the FS doesn't support symlinks.
        try:
            local_wav.symlink_to(vocals_path)
        except OSError:
            import shutil
            shutil.copy2(vocals_path, local_wav)

        mp3_path = _to_mp3(local_wav)
        if mp3_path is None:
            return None

        size_mb = mp3_path.stat().st_size / (1024 * 1024)
        if size_mb > MAX_INLINE_MB:
            print(
                f"[audio_asr] mp3 is {size_mb:.1f}MB > {MAX_INLINE_MB}MB cap; "
                "skipping (would exceed Gemini inline limit)"
            )
            return None

        try:
            audio_b64 = base64.standard_b64encode(mp3_path.read_bytes()).decode(
                "ascii"
            )
        except Exception as e:
            print(f"[audio_asr] base64 encode failed: {e}")
            return None

    import httpx

    body = {
        "contents": [{
            "role": "user",
            "parts": [
                {
                    "inline_data": {
                        "mime_type": "audio/mpeg",
                        "data": audio_b64,
                    },
                },
                {"text": _LYRICS_PROMPT},
            ],
        }],
        "generationConfig": {
            "temperature": 0.0,        # deterministic — we want recall, not flair
            "maxOutputTokens": 4096,
        },
    }

    try:
        # Generous timeout — Gemini audio inference for a 5+ minute stem
        # can run ~30-60s on the server side.
        r = httpx.post(
            GEMINI_ENDPOINT,
            params={"key": api_key},
            json=body,
            timeout=180.0,
        )
    except Exception as e:
        print(f"[audio_asr] gemini request failed: {e}")
        return None

    if r.status_code != 200:
        print(f"[audio_asr] gemini {r.status_code}: {r.text[:300]}")
        return None

    try:
        data = r.json() or {}
        candidates = data.get("candidates") or []
        if not candidates:
            print(f"[audio_asr] gemini returned no candidates: {data}")
            return None
        parts = (candidates[0].get("content") or {}).get("parts") or []
        text = "\n".join(p.get("text", "") for p in parts if p.get("text"))
        text = text.strip()
    except Exception as e:
        print(f"[audio_asr] gemini parse failed: {e}; body={r.text[:300]}")
        return None

    if not text or text.upper().startswith("UNKNOWN"):
        print("[audio_asr] gemini said UNKNOWN")
        return None

    # Sanity cap: keep it under the same 16k char ceiling Claude path uses.
    if len(text) > 16_000:
        text = text[:16_000]

    print(f"[audio_asr] gemini transcribed {len(text)} chars")
    return text
