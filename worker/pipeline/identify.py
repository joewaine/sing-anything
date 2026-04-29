"""Audio fingerprint identification via Chromaprint + AcoustID.

When a user uploads `track01.mp3` with no metadata, the LRCLIB lookup
in lyrics_verify.py has nothing to query against and Claude's name-
based fallback can't help either. Fingerprinting the audio itself
recovers the canonical track title + artist from a public crowdsourced
database (AcoustID / MusicBrainz), which then unlocks all downstream
lyric sources.

Pipeline:
    chromaprint (`fpcalc` binary) -> compact audio fingerprint
    AcoustID HTTP API              -> {recording_id, title, artist, score}

Module-level cache keys identifications by file SHA256 so re-uploads of
the same audio in a warm container skip the network round trip.

Returns None on any failure (missing API key, network error, no match,
score below threshold) — caller falls back to user-supplied metadata.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Optional

# Identification is best-effort and never blocks the user — every error
# path returns None so the orchestrator falls back to user-supplied
# name/artist (or to "Unknown" if those are empty).

# Confidence threshold below which we don't trust the match. AcoustID
# returns scores in [0..1]; 0.85+ is a strong signal that the
# fingerprint matched a specific recording rather than a near-twin.
# Below this, the answer is probably right but we'd rather defer to
# whatever the user typed than risk overwriting it with the wrong song.
MIN_SCORE = 0.85

# Per-process cache. Key = file content hash; value = identification
# dict (or None for negative caches so we don't refingerprint a track
# whose identification already failed once).
_CACHE: dict[str, Optional[dict]] = {}


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def identify_song(audio_path: Path) -> Optional[dict]:
    """Fingerprint `audio_path` and look up the recording on AcoustID.

    Returns {
        "title": str, "artist": str | None, "mbid": str | None,
        "score": float, "duration_s": float
    } on a confident match, else None.

    Requires ACOUSTID_API_KEY in env. Without it, returns None so the
    rest of the pipeline runs unchanged.
    """
    api_key = os.environ.get("ACOUSTID_API_KEY")
    if not api_key:
        print("[identify] ACOUSTID_API_KEY not set; skipping fingerprint")
        return None

    try:
        cache_key = _hash_file(audio_path)
    except Exception as e:
        print(f"[identify] hash failed: {e}")
        cache_key = None

    if cache_key and cache_key in _CACHE:
        cached = _CACHE[cache_key]
        if cached is None:
            print("[identify] cached negative result")
        else:
            print(f"[identify] cached hit: {cached.get('title')!r} "
                  f"by {cached.get('artist')!r}")
        return cached

    try:
        import acoustid
    except ImportError as e:
        print(f"[identify] pyacoustid missing: {e}")
        return None

    try:
        # acoustid.match calls fpcalc internally and queries AcoustID.
        # Returns a generator of (score, mbid, title, artist) tuples
        # sorted by descending score. We take the top hit.
        results = acoustid.match(api_key, str(audio_path))
    except acoustid.NoBackendError:
        print("[identify] fpcalc binary not found in PATH (apt-install "
              "libchromaprint-tools)")
        if cache_key:
            _CACHE[cache_key] = None
        return None
    except acoustid.WebServiceError as e:
        # Includes invalid-key and rate-limit cases.
        print(f"[identify] AcoustID API error: {e}")
        if cache_key:
            _CACHE[cache_key] = None
        return None
    except acoustid.FingerprintGenerationError as e:
        print(f"[identify] fingerprint generation failed: {e}")
        if cache_key:
            _CACHE[cache_key] = None
        return None
    except Exception as e:
        print(f"[identify] unexpected error: {e}")
        if cache_key:
            _CACHE[cache_key] = None
        return None

    best: Optional[dict] = None
    try:
        for score, mbid, title, artist in results:
            if score < MIN_SCORE:
                # Results are score-sorted; nothing below this point is
                # going to clear the bar either.
                break
            best = {
                "title": title or "",
                "artist": artist or None,
                "mbid": mbid,
                "score": float(score),
            }
            break
    except Exception as e:
        print(f"[identify] result iteration failed: {e}")
        best = None

    if best:
        print(
            f"[identify] match: {best['title']!r} by {best['artist']!r} "
            f"(score={best['score']:.2f}, mbid={best['mbid']})"
        )
    else:
        print("[identify] no confident match")

    if cache_key:
        _CACHE[cache_key] = best
    return best


def looks_generic(name: str | None) -> bool:
    """Heuristic: should we let a fingerprint match overwrite this name?

    A user who uploaded an mp3 named "Hey Jude" wants that to stay even
    if the fingerprint disagrees (covers, remasters, live versions can
    all match different MBIDs). But "track01.mp3", "Untitled", and
    empty strings are clearly placeholder — fingerprint wins.
    """
    if not name:
        return True
    n = name.strip().lower()
    if not n:
        return True
    if n in {"unknown", "untitled", "track", "audio", "song"}:
        return True
    # Filename-y patterns: starts with "track", all-numeric, "song12",
    # "audio_001". Anything that has no spaces AND contains digits.
    if " " not in n and any(ch.isdigit() for ch in n):
        return True
    return False
