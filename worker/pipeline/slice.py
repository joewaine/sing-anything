"""ffmpeg-based phrase slicing + Supabase Storage upload.

Mirrors Sing Beatles' slice settings: CLIP_PAD_MS = 150, Vorbis quality 6.
"""

from __future__ import annotations

import re
import subprocess
import time
from pathlib import Path
from typing import Any

CLIP_PAD_MS = 150
UPLOAD_MAX_RETRIES = 3
UPLOAD_BACKOFF_BASE_S = 0.5


def _slugify(text: str, max_len: int = 40) -> str:
    text = (text or "").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return (text[:max_len] or "phrase").strip("-")


def slice_phrase(
    vocals_path: Path,
    backing_path: Path,
    phrase: dict,
    song_id: str,
    idx: int,
    out_dir: Path,
) -> dict:
    """ffmpeg-cut vocals + backing for this phrase. Returns phrase with slug + local paths."""
    label = _slugify(phrase.get("lyric_text") or f"phrase-{idx:03d}")
    slug = f"{song_id[:8]}-{phrase['phrase_type']}-{idx:03d}-{label}"

    start_s = max(0.0, (phrase["start_ms"] - CLIP_PAD_MS) / 1000.0)
    end_s = (phrase["end_ms"] + CLIP_PAD_MS) / 1000.0

    vocals_out = out_dir / f"{slug}__vocals.ogg"
    backing_out = out_dir / f"{slug}__backing.ogg"

    for src, dest in [(vocals_path, vocals_out), (backing_path, backing_out)]:
        subprocess.check_call([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-ss", f"{start_s:.3f}",
            "-to", f"{end_s:.3f}",
            "-i", str(src),
            "-c:a", "libvorbis",
            "-q:a", "6",
            str(dest),
        ])

    return {**phrase, "slug": slug, "_vocals_local": vocals_out, "_backing_local": backing_out}


def _upload_with_retry(
    supabase: Any,
    bucket: str,
    path: str,
    blob: bytes,
    content_type: str,
) -> None:
    """Retry wrapper around Storage uploads — shields against transient
    `Server disconnected` / `ConnectError` under the thread-pool concurrency."""
    last_exc: Exception | None = None
    for attempt in range(UPLOAD_MAX_RETRIES):
        try:
            supabase.storage.from_(bucket).upload(
                path=path,
                file=blob,
                file_options={"content-type": content_type, "upsert": "true"},
            )
            return
        except Exception as exc:  # noqa: BLE001 — intentional catch-all for retry
            last_exc = exc
            if attempt == UPLOAD_MAX_RETRIES - 1:
                break
            time.sleep(UPLOAD_BACKOFF_BASE_S * (2 ** attempt))
    raise RuntimeError(f"upload {path} failed after {UPLOAD_MAX_RETRIES} tries: {last_exc}")


def upload_slice(
    supabase: Any,
    user_id: str,
    song_id: str,
    sliced: dict,
    bucket: str = "phrases",
) -> dict:
    """Upload vocals + backing for one sliced phrase; return phrase with storage paths."""
    slug = sliced["slug"]
    vocals_path = f"{user_id}/{song_id}/{slug}__vocals.ogg"
    backing_path = f"{user_id}/{song_id}/{slug}__backing.ogg"

    _upload_with_retry(
        supabase, bucket, vocals_path,
        sliced["_vocals_local"].read_bytes(), "audio/ogg",
    )
    _upload_with_retry(
        supabase, bucket, backing_path,
        sliced["_backing_local"].read_bytes(), "audio/ogg",
    )

    clean = {k: v for k, v in sliced.items() if not k.startswith("_")}
    clean["vocals_path"] = vocals_path
    clean["backing_path"] = backing_path
    return clean
