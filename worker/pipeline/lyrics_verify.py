"""Best-effort lyric correction of the WhisperX transcription.

Strategy (each tier falls through to the next on miss):
  1. LRCLIB synced lyrics — LRC format with per-line timestamps. Best
     possible signal: we know exactly when each canonical line should
     start, so alignment is per-window instead of fighting chorus
     repeats across the whole song.
  2. LRCLIB plain lyrics — text-only canonical lyrics, aligned to
     whisper via global SequenceMatcher.
  3. Claude name-lookup — ask Claude for the song's full lyrics by
     title/artist. Plain text path.
  4. Gemini audio ASR — multimodal model transcribes the actual vocals
     stem. Used when the song is too obscure for LRCLIB or Claude to
     know by name. Plain text path.

All paths produce a list of word dicts with the same shape WhisperX
emits — only `word` text changes (and timestamps for inserted words
recovered from canonical sources whisper missed).
"""

from __future__ import annotations

import difflib
import json
import os
import re
from pathlib import Path
from typing import Any, Optional

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
# round trips entirely. Keyed by normalized (name, artist). Value is a
# dict {"synced": list[LrcLine] | None, "plain": str | None} — both
# fields populated independently because LRCLIB sometimes returns one
# but not the other. None caches a confirmed miss.
_LYRICS_CACHE: dict[tuple[str, str], Optional[dict]] = {}
_LYRICS_CACHE_MAX = 256

# LRC timestamp pattern: [mm:ss.xx] or [mm:ss.xxx]. Hours are not in
# spec but some files use [hh:mm:ss.xx]; we accept both.
_LRC_TIMESTAMP_RE = re.compile(
    r"\[(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]"
)
# Metadata tags inside square brackets that aren't timestamps (ar, ti,
# al, au, length, by, offset, re, ve, …). These get stripped before
# alignment so they don't pollute the canonical token stream.
_LRC_META_RE = re.compile(r"\[[a-zA-Z]+:[^\]]*\]")


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


def _parse_lrc(lrc_text: str) -> list[dict]:
    """Parse LRC-format text into [{start_ms, text}, ...].

    Handles:
      - `[mm:ss.xx] line text` standard syntax
      - `[mm:ss.xxx] line text` 3-decimal precision
      - `[hh:mm:ss.xx] line text` (rare)
      - Multiple timestamps per line: `[00:01.00][00:30.00] chorus`
        emits two entries pointing at the same text
      - Metadata-only lines (`[ar:Beatles]`) are skipped
      - Pure-timestamp lines with empty text (instrumental gaps) are
        skipped — they have no lyric content to align against

    Returned lines are sorted by start_ms ascending. Empty input → [].
    """
    out: list[dict] = []
    if not lrc_text:
        return out
    for raw in lrc_text.splitlines():
        line = raw.strip()
        if not line:
            continue
        # Strip metadata tags so they don't show up as text content.
        text_part = _LRC_META_RE.sub("", line)
        # Find ALL timestamps on this line (some LRCs put repeats inline).
        timestamps: list[int] = []
        last_end = 0
        for m in _LRC_TIMESTAMP_RE.finditer(text_part):
            hh = int(m.group(1)) if m.group(1) else 0
            mm = int(m.group(2))
            ss = int(m.group(3))
            frac_raw = m.group(4) or "0"
            # Normalize fraction: "5"=>500ms, "50"=>500ms, "500"=>500ms.
            frac_ms = int(frac_raw.ljust(3, "0")[:3])
            ms = ((hh * 3600) + (mm * 60) + ss) * 1000 + frac_ms
            timestamps.append(ms)
            last_end = m.end()
        if not timestamps:
            continue
        text = text_part[last_end:].strip()
        # An empty-text timestamp is an instrumental marker — skip it
        # (alignment doesn't need empty windows; those gaps fall to
        # whichever lines bracket them).
        if not text:
            continue
        for ts in timestamps:
            out.append({"start_ms": ts, "text": text})
    out.sort(key=lambda e: e["start_ms"])
    return out


def _lrclib_fetch_uncached(song_name: str, artist: str | None) -> Optional[dict]:
    """Hit LRCLIB and return both syncedLyrics (parsed) and plainLyrics
    when available. Returns None on miss. Synced is a list of line
    dicts; plain is the raw text. Either field can be present without
    the other depending on what LRCLIB has indexed.
    """
    import httpx

    def _build(record: dict) -> Optional[dict]:
        synced_raw = record.get("syncedLyrics") or ""
        plain_raw = record.get("plainLyrics") or ""
        synced = _parse_lrc(synced_raw) if synced_raw else []
        if not synced and not plain_raw:
            return None
        return {
            "synced": synced if synced else None,
            "plain": str(plain_raw) if plain_raw else None,
        }

    try:
        if artist:
            r = httpx.get(
                LRCLIB_ENDPOINT,
                params={"track_name": song_name, "artist_name": artist},
                timeout=10.0,
                headers={"User-Agent": "sing-anything/0.1"},
            )
            if r.status_code == 200:
                built = _build(r.json() or {})
                if built:
                    return built
        # Fallback: free-text search, take the top hit that has lyrics.
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
                built = _build(hit)
                if built:
                    return built
    except Exception as e:
        print(f"[lyrics_verify] lrclib error: {e}")
    return None


def _lrclib_fetch(song_name: str, artist: str | None) -> Optional[dict]:
    """Memoized LRCLIB lookup. Returns {"synced": [...] | None,
    "plain": str | None} on hit; None on miss. Same (name, artist)
    re-uploaded never hits the network twice in this container's life."""
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


def _align_with_synced_lines(
    words: list[dict],
    lrc_lines: list[dict],
) -> Optional[list[dict]]:
    """Per-line alignment using LRC timestamps as anchors.

    For each canonical line we know exactly when it should start in the
    audio. We bucket whisper words into the line windows, then run a
    short SequenceMatcher inside each bucket. This avoids the global
    matcher's failure mode on choruses (whisper transcribes the chorus
    twice; canonical text shows it twice; the matcher picks the wrong
    pairing and corrupts both verses around it).

    Boundaries are extended slightly outward (BUCKET_PAD_MS) to absorb
    whisper alignment jitter — a word starting 50ms before the
    canonical line still ends up in the right bucket.

    Returns a flat list of aligned word dicts, or None if there isn't
    enough overlap between whisper and canonical to be useful (rare —
    the synced timestamps come from LRCLIB which already verified the
    lyric matches the recording).
    """
    if not lrc_lines or not words:
        return None

    # How far outside the LRC window to consider whisper words. LRC
    # accuracy is typically ±100-300ms; whisper word timestamps drift
    # ±50-150ms. Pad both sides by 250ms so honest near-matches don't
    # get orphaned across a hard boundary.
    BUCKET_PAD_MS = 250

    # End-of-window for line i is the start of line i+1 (or +infinity
    # for the last line; we cap with the last whisper end + 1s).
    last_end_ms = int(max((w.get("end") or 0) for w in words) * 1000) + 1000
    line_windows: list[tuple[int, int, str]] = []
    for i, line in enumerate(lrc_lines):
        start = max(0, int(line["start_ms"]) - BUCKET_PAD_MS)
        end = (
            int(lrc_lines[i + 1]["start_ms"]) + BUCKET_PAD_MS
            if i + 1 < len(lrc_lines)
            else last_end_ms
        )
        line_windows.append((start, end, line["text"]))

    used = [False] * len(words)
    out: list[dict] = []
    inserted_total = 0
    matched_total = 0

    for line_idx, (win_start, win_end, line_text) in enumerate(line_windows):
        # Whisper words whose start lands in this LRC window. Each word
        # is claimed by exactly one window (first wins) so chorus
        # repeats don't double-pull the same words.
        bucket: list[tuple[int, dict]] = []
        for wi, w in enumerate(words):
            if used[wi]:
                continue
            ws_ms = int((w.get("start") or 0) * 1000)
            if win_start <= ws_ms < win_end:
                bucket.append((wi, w))
        for wi, _ in bucket:
            used[wi] = True

        canon_pairs = _tokens_with_original(line_text)
        if not canon_pairs:
            # Empty/unrenderable line — drop whatever whisper had here.
            for _, w in bucket:
                out.append(dict(w))
            continue

        if not bucket:
            # Whisper missed this line entirely; synthesize words from
            # canonical, spread evenly across the LRC window. Score is
            # downgraded since these are pure inserts.
            real_start = max(0, win_start + BUCKET_PAD_MS) / 1000.0
            real_end = max(real_start + 0.05,
                           (win_end - BUCKET_PAD_MS) / 1000.0)
            span = real_end - real_start
            n = len(canon_pairs)
            for k, (_, original) in enumerate(canon_pairs):
                s = real_start + span * (k / max(1, n))
                e = real_start + span * ((k + 1) / max(1, n))
                out.append({
                    "start": float(s),
                    "end": float(e),
                    "word": original,
                    "score": 0.3,  # marked low — pure inserts
                })
                inserted_total += 1
            continue

        # Both sides have content; run SequenceMatcher on this bucket
        # only. Reuses the same opcode handling as the global aligner
        # but scoped — chorus repeats can't bleed across buckets.
        whisp_norms = [_tokenize(w["word"]) for _, w in bucket]
        whisp_tokens = [(toks[0] if toks else "") for toks in whisp_norms]
        canon_tokens = [p[0] for p in canon_pairs]
        matcher = difflib.SequenceMatcher(None, whisp_tokens, canon_tokens)

        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            canon_run = canon_pairs[j1:j2]
            whisp_run = [bucket[i][1] for i in range(i1, i2)]
            if tag == "equal":
                for k, w in enumerate(whisp_run):
                    copy = dict(w)
                    if k < len(canon_run):
                        copy["word"] = canon_run[k][1]
                    out.append(copy)
                matched_total += len(whisp_run)
            elif tag == "replace":
                if len(canon_run) <= len(whisp_run):
                    for k in range(len(whisp_run)):
                        copy = dict(whisp_run[k])
                        if canon_run:
                            idx = int(round(
                                k * (len(canon_run) - 1) / max(1, len(whisp_run) - 1)
                            ))
                            idx = max(0, min(idx, len(canon_run) - 1))
                            copy["word"] = canon_run[idx][1]
                        out.append(copy)
                else:
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
                            "score": float(score_base) * 0.7,
                        })
                        if k >= len(whisp_run):
                            inserted_total += 1
            elif tag == "insert":
                # Canon has words whisper missed inside this LRC line.
                # Place them between prev_end and the next whisper word
                # in the same bucket — falls back to the LRC line edges
                # if there are no whisper bookends.
                prev_end = (
                    float(out[-1]["end"]) if out else win_start / 1000.0
                )
                next_start = (
                    float(bucket[i1][1]["start"])
                    if i1 < len(bucket)
                    else win_end / 1000.0
                )
                for k, (_, original) in enumerate(canon_run):
                    slot = _interp_word(
                        prev_end, next_start, k, len(canon_run),
                        whisp_run[0] if whisp_run else (out[-1] if out else {}),
                    )
                    slot["word"] = original
                    out.append(slot)
                    inserted_total += 1
            elif tag == "delete":
                # Whisper had words canon doesn't (likely repeats /
                # adlibs). Keep them — real audible content.
                for w in whisp_run:
                    out.append(dict(w))

    # Orphan whisper words outside every LRC window (intro / outro
    # adlibs). Keep them rather than dropping, in time order.
    for wi, w in enumerate(words):
        if not used[wi]:
            out.append(dict(w))

    # Sort by start so the inserted-line synthesis and the orphans end
    # up in playback order.
    out.sort(key=lambda w: float(w.get("start") or 0))

    print(
        f"[lyrics_verify] synced align: lines={len(lrc_lines)} "
        f"whisper_words={len(words)} matched={matched_total} "
        f"inserted={inserted_total} out={len(out)}"
    )
    if matched_total + inserted_total < max(3, len(words) // 4):
        # Less than a quarter of whisper aligned to canonical — synced
        # path is misbehaving (likely a bad LRC offset). Bail to plain.
        print("[lyrics_verify] synced match too sparse; falling back")
        return None
    return out


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
    # whisper_match_rate = fraction of whisper's transcribed words that
    # align cleanly to a canonical token. When whisper is sparse but
    # accurate (got 3 of the 12 sung words right), the joint ratio
    # comes out low (≈ 0.4 here) because canonical has many more
    # words — but the 3 it found ARE correct anchors and the canonical
    # merge would correctly insert the missing 9. Joint ratio alone
    # would reject this; whisper_match_rate >= 0.6 lets it through.
    matched = sum(
        i2 - i1
        for tag, i1, i2, j1, j2 in matcher.get_opcodes()
        if tag == "equal"
    )
    whisper_match_rate = matched / max(1, len(whisper_tokens))
    print(
        f"[lyrics_verify] lrclib ratio={ratio:.2f} whisper_match={whisper_match_rate:.2f} "
        f"whisper={len(whisper_tokens)} canon={len(canon_tokens)}"
    )
    if ratio < LRCLIB_MIN_RATIO and whisper_match_rate < 0.6:
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


def _claude_full_lyrics(song_name: str, artist: str | None) -> Optional[str]:
    """Ask Claude for the full canonical lyrics of a song as plain text.
    Used as a fallback when LRCLIB doesn't have the song. The plain
    text is fed back through _align_canonical so missing words can be
    inserted with interpolated timestamps — same code path as the
    LRCLIB result. Earlier this function only returned a same-count
    word list (preserving whisper's count), which meant whisper-missed
    words could never be recovered through the Claude path.
    """
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None

    import httpx

    song_desc = f"{song_name}" + (f" by {artist}" if artist else "")

    system = (
        "Return the full canonical lyrics of the requested song as plain "
        "text. One song line per text line. Do not include section "
        "markers like [Verse] or [Chorus]. Do not include translations, "
        "annotations, or commentary. If you don't know the song, "
        "respond with the literal token UNKNOWN and nothing else."
    )
    user = f"Song: {song_desc}\n\nReturn the lyrics as plain text."

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
                "max_tokens": 4096,
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
        text = text.strip()
        if not text or text.upper().startswith("UNKNOWN"):
            return None
        # Sanity-cap: Claude shouldn't be returning a novel.
        if len(text) > 16_000:
            text = text[:16_000]
        return text
    except Exception as e:
        print(f"[lyrics_verify] claude error: {e}")
        return None


def verify_lyrics(
    words: list[dict],
    song_name: str | None,
    artist: str | None,
    vocals_path: Optional[Path] = None,
) -> tuple[list[dict], str]:
    """Return (possibly-corrected words, source). Source is one of
    'lrclib_synced' | 'lrclib_plain' | 'claude' | 'gemini_audio' | 'none'.

    Tiers fall through to the next on miss:
      1. LRCLIB syncedLyrics — best signal, per-line time anchors
      2. LRCLIB plainLyrics — text-only, global SequenceMatcher
      3. Claude name-lookup — full lyrics from the LLM by song/artist
      4. Gemini audio ASR — multimodal model on the vocal stem (only
         when `vocals_path` is given; lets us recover lyrics for songs
         no public DB knows about)

    Skips the Claude/Gemini fallbacks when LRCLIB returned a strong
    plain match (ratio >= LRCLIB_HIGH_CONFIDENCE) — they can't
    meaningfully improve on a canonical match that already aligned
    cleanly, and both involve expensive API round trips.
    """
    if not words:
        return words, "none"

    # 1. LRCLIB
    if song_name:
        record = _lrclib_fetch(song_name, artist)
        if record:
            # 1a. Synced (preferred)
            synced = record.get("synced")
            if synced:
                aligned = _align_with_synced_lines(words, synced)
                if aligned is not None:
                    return aligned, "lrclib_synced"
            # 1b. Plain (fallback within LRCLIB tier)
            plain = record.get("plain")
            if plain:
                aligned, ratio = _align_canonical(words, plain)
                if aligned is not None:
                    return aligned, "lrclib_plain"
                if ratio >= LRCLIB_HIGH_CONFIDENCE:
                    # LRCLIB knows the song with high confidence but
                    # our matcher tripped — bail rather than risk
                    # corrupting an already-good match with downstream
                    # tiers.
                    return words, "none"

    # 2. Claude name-lookup
    if song_name:
        claude_lyrics = _claude_full_lyrics(song_name, artist)
        if claude_lyrics:
            aligned, _ = _align_canonical(words, claude_lyrics)
            if aligned is not None:
                return aligned, "claude"

    # 3. Gemini audio ASR (lazy import — Gemini is optional)
    if vocals_path is not None:
        try:
            from .audio_asr import gemini_lyrics
        except ImportError as e:
            print(f"[lyrics_verify] gemini path unavailable: {e}")
            gemini_lyrics = None
        if gemini_lyrics is not None:
            transcript = gemini_lyrics(vocals_path)
            if transcript:
                aligned, _ = _align_canonical(words, transcript)
                if aligned is not None:
                    return aligned, "gemini_audio"

    return words, "none"
