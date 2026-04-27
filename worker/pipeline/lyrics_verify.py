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
# Above this ratio we trust LRCLIB enough to skip the Claude fallback —
# saves a 2–4s LLM round trip on the critical path when the canonical
# alignment is already strong.
LRCLIB_HIGH_CONFIDENCE = 0.85

# Module-level memoization so repeat catalog songs (same name+artist
# uploaded by different users, or re-uploads) skip the LRCLIB and Claude
# round trips entirely. Keyed by normalized (name, artist).
_LYRICS_CACHE: dict[tuple[str, str], str | None] = {}
_LYRICS_CACHE_MAX = 256


def _cache_key(name: str | None, artist: str | None) -> tuple[str, str]:
    return (
        (name or "").strip().lower(),
        (artist or "").strip().lower(),
    )


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


def _lrclib_fetch_uncached(song_name: str, artist: str | None) -> Optional[str]:
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


def _lrclib_fetch(song_name: str, artist: str | None) -> Optional[str]:
    """Memoized LRCLIB lookup. Same (name, artist) re-uploaded never hits the
    network twice in this container's lifetime."""
    key = _cache_key(song_name, artist)
    if key in _LYRICS_CACHE:
        return _LYRICS_CACHE[key]
    if len(_LYRICS_CACHE) >= _LYRICS_CACHE_MAX:
        # crude eviction — drop oldest insertion order entry
        try:
            _LYRICS_CACHE.pop(next(iter(_LYRICS_CACHE)))
        except StopIteration:
            pass
    result = _lrclib_fetch_uncached(song_name, artist)
    _LYRICS_CACHE[key] = result
    return result


def prefetch_lrclib(song_name: str | None, artist: str | None) -> None:
    """Fire-and-forget: warm the cache for this song while other pipeline
    stages run. Intended to be called from a thread early in process_song."""
    if not song_name:
        return
    try:
        _lrclib_fetch(song_name, artist)
    except Exception as e:
        print(f"[lyrics_verify] prefetch error: {e}")


def _interp_word(prev_end: float, next_start: float, k: int, total: int, base: dict) -> dict:
    """Build a synthetic word dict between two whisper words by linear
    interpolation. The base dict carries the original whisper word's score
    so we don't claim higher confidence than we have.
    """
    span = max(0.0, next_start - prev_end)
    # Slot k of total inside [prev_end, next_start]
    s = prev_end + span * (k / max(1, total))
    e = prev_end + span * ((k + 1) / max(1, total))
    return {
        "start": float(s),
        "end": float(e),
        "word": "",  # filled in by caller
        "score": float(base.get("score", 0.0)) * 0.5,  # synthetic — half score
    }


def _align_canonical(
    words: list[dict],
    canonical_text: str,
) -> tuple[Optional[list[dict]], float]:
    """Align canonical lyric tokens to whisper's word sequence.

    Returns (corrected_words | None, ratio). When LRCLIB has words whisper
    missed entirely (insert / longer replace runs), they are emitted with
    interpolated timestamps so the lyric strip and piano roll show the
    full line — even if the underlying audio frames don't have a clean
    pitch sample for them. notes.py's MIN_FRAMES_PER_NOTE guard keeps any
    noisy synthetic notes from polluting the roll; the lyric still shows.

    The ratio is exposed so the caller can skip the Claude fallback when
    LRCLIB is already high-confidence.
    """
    whisper_norms = [_tokenize(w["word"]) for w in words]
    whisper_tokens = [(toks[0] if toks else "") for toks in whisper_norms]
    canon_pairs = _tokens_with_original(canonical_text)
    canon_tokens = [p[0] for p in canon_pairs]

    if not canon_tokens or not whisper_tokens:
        return None, 0.0

    matcher = difflib.SequenceMatcher(None, whisper_tokens, canon_tokens)
    ratio = matcher.ratio()
    print(
        f"[lyrics_verify] lrclib ratio={ratio:.2f} whisper={len(whisper_tokens)} "
        f"canon={len(canon_tokens)}"
    )
    if ratio < LRCLIB_MIN_RATIO:
        return None, ratio

    out: list[dict] = []
    inserted = 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        canon_run = canon_pairs[j1:j2]
        whisp_run = words[i1:i2]
        if tag == "equal":
            # Whisper had it right; capitalize / punctuate from canonical.
            for k, w in enumerate(whisp_run):
                copy = dict(w)
                if k < len(canon_run):
                    copy["word"] = canon_run[k][1]
                out.append(copy)
        elif tag == "replace":
            if len(canon_run) <= len(whisp_run):
                # Same or fewer canonical words — stretch to fit whisper slots.
                for k in range(len(whisp_run)):
                    copy = dict(whisp_run[k])
                    if canon_run:
                        idx = int(round(k * (len(canon_run) - 1) / max(1, len(whisp_run) - 1)))
                        idx = max(0, min(idx, len(canon_run) - 1))
                        copy["word"] = canon_run[idx][1]
                    out.append(copy)
            else:
                # Canonical has MORE words than whisper detected — distribute
                # across whisper's time span so missed words reappear.
                span_start = float(whisp_run[0]["start"])
                span_end = float(whisp_run[-1]["end"])
                span = max(0.0, span_end - span_start)
                for k, (_, original) in enumerate(canon_run):
                    s = span_start + span * (k / max(1, len(canon_run)))
                    e = span_start + span * ((k + 1) / max(1, len(canon_run)))
                    score_base = whisp_run[min(k, len(whisp_run) - 1)].get("score", 0.0)
                    out.append({
                        "start": float(s),
                        "end": float(e),
                        "word": original,
                        "score": float(score_base) * 0.7,  # mix of whisper conf and our guess
                    })
                    inserted += max(0, 1 if k >= len(whisp_run) else 0)
        elif tag == "insert":
            # Canonical has words whisper missed entirely. Place them in the
            # time gap between whisper's previous and next word.
            prev_end = float(out[-1]["end"]) if out else 0.0
            # Look ahead: next anchor is whisper word at i1 (which is the
            # first word of the next opcode's whisper range).
            next_start = (
                float(words[i1]["start"]) if i1 < len(words) else (prev_end + 1.0)
            )
            for k, (_, original) in enumerate(canon_run):
                slot = _interp_word(prev_end, next_start, k, len(canon_run),
                                    whisp_run[0] if whisp_run else (out[-1] if out else {}))
                slot["word"] = original
                out.append(slot)
                inserted += 1
        elif tag == "delete":
            # Whisper had words canon doesn't (chorus repeats, ad-libs). Keep
            # whisper's text — these are real audible sounds we shouldn't drop.
            for w in whisp_run:
                out.append(dict(w))

    if inserted:
        print(f"[lyrics_verify] inserted {inserted} canonical words missed by whisper")

    return out, ratio


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
    'lrclib' | 'claude' | 'none'.

    Skips the Claude fallback when LRCLIB returned a high-confidence match
    (alignment ratio >= LRCLIB_HIGH_CONFIDENCE) — Claude can't meaningfully
    improve on canonical lyrics that already aligned cleanly, and the LLM
    round trip is the most expensive thing in this function.
    """
    if not song_name or not words:
        return words, "none"

    canonical = _lrclib_fetch(song_name, artist)
    if canonical:
        aligned, ratio = _align_canonical(words, canonical)
        if aligned is not None:
            return aligned, "lrclib"
        if ratio >= LRCLIB_HIGH_CONFIDENCE:
            # LRCLIB has the song with high confidence but our matcher
            # tripped on something — still skip Claude (it'd see the same
            # whisper text and be tempted to over-correct).
            return words, "none"

    claude_fixed = _claude_fetch(words, song_name, artist)
    if claude_fixed is not None:
        return claude_fixed, "claude"

    return words, "none"
