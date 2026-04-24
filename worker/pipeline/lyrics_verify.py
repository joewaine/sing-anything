"""Best-effort lyric correction of the WhisperX transcription.

Strategy:
  1. Try LRCLIB — free, open-source lyric DB. If it has the song and the
     canonical text aligns reasonably well to whisper, replace whisper's word
     text with canonical (keeping whisper's timestamps).
  2. Try Claude — ask it to correct per-word mistakes in place. Only fires
     when LRCLIB missed AND ANTHROPIC_API_KEY is in the env.
  3. If neither works, return whisper words unchanged.

Both paths preserve the word count and timestamps — only `word` text changes.
"""

from __future__ import annotations

import difflib
import json
import os
import re
from typing import Optional

LRCLIB_ENDPOINT = "https://lrclib.net/api/get"
LRCLIB_SEARCH_ENDPOINT = "https://lrclib.net/api/search"
ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL = "claude-sonnet-4-6"

# If SequenceMatcher.ratio() is below this, we treat LRCLIB's result as a
# mismatch rather than risk "correcting" whisper into something worse.
LRCLIB_MIN_RATIO = 0.55


def _tokenize(text: str) -> list[str]:
    """Whitespace tokens, lowercased, punctuation stripped — used for matching
    only. Original text is preserved separately for substitution."""
    cleaned = re.sub(r"\[[^\]]+\]", " ", text or "")  # drop [verse]/[chorus]
    cleaned = re.sub(r"[^\w\s']", " ", cleaned)
    return [t for t in cleaned.lower().split() if t]


def _tokens_with_original(text: str) -> list[tuple[str, str]]:
    """(norm, original) pairs. Original keeps capitalization/punctuation so we
    can substitute lyrics-style text back into whisper's words."""
    cleaned = re.sub(r"\[[^\]]+\]", " ", text or "")
    pairs: list[tuple[str, str]] = []
    for raw in cleaned.split():
        norm = re.sub(r"[^\w']", "", raw).lower()
        if norm:
            pairs.append((norm, raw))
    return pairs


def _lrclib_fetch(song_name: str, artist: str | None) -> Optional[str]:
    import httpx

    try:
        if artist:
            r = httpx.get(
                LRCLIB_ENDPOINT,
                params={"track_name": song_name, "artist_name": artist},
                timeout=10.0,
                headers={"User-Agent": "sing-anything/0.1"},
            )
            if r.status_code == 200:
                plain = (r.json() or {}).get("plainLyrics")
                if plain:
                    return str(plain)
        # Fallback: free-text search, take the top hit.
        q = f"{song_name} {artist}".strip() if artist else song_name
        r = httpx.get(
            LRCLIB_SEARCH_ENDPOINT,
            params={"q": q},
            timeout=10.0,
            headers={"User-Agent": "sing-anything/0.1"},
        )
        if r.status_code == 200:
            hits = r.json() or []
            for hit in hits[:3]:
                plain = hit.get("plainLyrics")
                if plain:
                    return str(plain)
    except Exception as e:
        print(f"[lyrics_verify] lrclib error: {e}")
    return None


def _align_canonical(
    words: list[dict],
    canonical_text: str,
) -> Optional[list[dict]]:
    """Align canonical lyric tokens to whisper's word sequence. Returns a new
    list with swapped `word` text if the alignment is good enough, else None."""
    whisper_norms = [_tokenize(w["word"]) for w in words]
    whisper_tokens = [(toks[0] if toks else "") for toks in whisper_norms]
    canon_pairs = _tokens_with_original(canonical_text)
    canon_tokens = [p[0] for p in canon_pairs]

    if not canon_tokens or not whisper_tokens:
        return None

    matcher = difflib.SequenceMatcher(None, whisper_tokens, canon_tokens)
    ratio = matcher.ratio()
    print(f"[lyrics_verify] lrclib ratio={ratio:.2f} whisper={len(whisper_tokens)} canon={len(canon_tokens)}")
    if ratio < LRCLIB_MIN_RATIO:
        return None

    corrected = [dict(w) for w in words]
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            # Whisper had it right, but capitalize / punctuate from canonical.
            for k in range(i2 - i1):
                if j1 + k < len(canon_pairs):
                    corrected[i1 + k]["word"] = canon_pairs[j1 + k][1]
        elif tag == "replace":
            # Whisper had wrong words; use canonical text for as many slots
            # as whisper occupied (stretch or compress to fit).
            canon_run = canon_pairs[j1:j2]
            whisp_slots = i2 - i1
            for k in range(whisp_slots):
                # Map whisper position k to canonical position
                idx = int(round(k * (len(canon_run) - 1) / max(1, whisp_slots - 1)))
                idx = max(0, min(idx, len(canon_run) - 1)) if canon_run else -1
                if idx >= 0:
                    corrected[i1 + k]["word"] = canon_run[idx][1]
        # For 'insert' (canon has extra words) and 'delete' (whisper had extra),
        # we leave whisper's original text. Mismatch is usually background
        # vocals / repeated choruses — safer to keep whisper than invent words.

    return corrected


def _claude_fetch(words: list[dict], song_name: str, artist: str | None) -> Optional[list[dict]]:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None

    import httpx

    whisper_text = " ".join(w["word"] for w in words).strip()
    if not whisper_text:
        return None

    song_desc = f"{song_name}" + (f" by {artist}" if artist else "")

    system = (
        "You correct word-level transcription errors in sung lyrics. "
        "Return JSON: {\"recognized\": bool, \"words\": string[]}. "
        "If you know the song, return a corrected word list with the SAME "
        "COUNT and ORDER as the input. Only change words that are clearly "
        "wrong. Do not add or remove words. If you don't know the song, "
        "set recognized=false and omit 'words'."
    )
    user = (
        f"Song: {song_desc}\n\n"
        f"WhisperX transcribed ({len(words)} words):\n{whisper_text}\n\n"
        "Return JSON."
    )

    try:
        r = httpx.post(
            ANTHROPIC_ENDPOINT,
            headers={
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": ANTHROPIC_MODEL,
                "max_tokens": 2048,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            },
            timeout=30.0,
        )
        if r.status_code != 200:
            print(f"[lyrics_verify] claude {r.status_code}: {r.text[:200]}")
            return None
        blocks = (r.json() or {}).get("content") or []
        text = next((b.get("text", "") for b in blocks if b.get("type") == "text"), "")
        # Extract JSON from Claude's text (may have surrounding prose)
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return None
        payload = json.loads(m.group(0))
        if not payload.get("recognized"):
            return None
        new_words = payload.get("words")
        if not isinstance(new_words, list) or len(new_words) != len(words):
            print(f"[lyrics_verify] claude returned {len(new_words) if isinstance(new_words, list) else 'non-list'}"
                  f" words vs whisper {len(words)}; ignoring")
            return None
        return [{**w, "word": str(nw).strip()} for w, nw in zip(words, new_words)]
    except Exception as e:
        print(f"[lyrics_verify] claude error: {e}")
        return None


def verify_lyrics(
    words: list[dict],
    song_name: str | None,
    artist: str | None,
) -> tuple[list[dict], str]:
    """Return (possibly-corrected words, source). Source is one of
    'lrclib' | 'claude' | 'none'."""
    if not song_name or not words:
        return words, "none"

    canonical = _lrclib_fetch(song_name, artist)
    if canonical:
        aligned = _align_canonical(words, canonical)
        if aligned is not None:
            return aligned, "lrclib"

    claude_fixed = _claude_fetch(words, song_name, artist)
    if claude_fixed is not None:
        return claude_fixed, "claude"

    return words, "none"
