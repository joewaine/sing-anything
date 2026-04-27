"""Phrase detection from whisper word timestamps.

Splits the song into phrases using the actual sung words rather than RMS
silence. Production-style songs (heavy reverb, ambient pads bleeding into
the vocal stem) often have very few -40dBFS gaps even between distinct
sung lines, so RMS-based detection collapsed lots of words into a few
mega-lines. Word-timestamp-based splitting is dramatically more reliable
for every kind of song that has lyrics.

Algorithm:

  1. Sort whisper words by start time.
  2. Walk them; start a new phrase when:
     - the gap between previous word's end and current word's start >=
       PHRASE_GAP_MS, OR
     - the running phrase is already >= MAX_LINE_S long (split on next
       word boundary).
  3. Drop phrases shorter than MIN_PHRASE_MS (one-word stragglers).
  4. Project each note's start/end into clip-relative time by subtracting
     `clip_start = max(0, phrase_start - CLIP_PAD_MS)` (matches slice.py's
     ffmpeg cut start).
  5. Group 3–5 consecutive lines into verses, capped at MAX_VERSE_MS.

Note timestamps on emitted phrases are relative to the audio CLIP start
(not the phrase boundary) because slice.py begins each clip CLIP_PAD_MS
before the phrase's first sung syllable. Without that offset the lyric
highlight fires ~150ms early on every phrase.
"""

from __future__ import annotations

from pathlib import Path

# IMPORTANT: keep these in sync with slice.py — when ffmpeg produces a
# clip it starts max(0, phrase_start - CLIP_PAD_MS - LEAD_IN_MS) into the
# original audio. Note timestamps below are made relative to that same
# clip start.
CLIP_PAD_MS = 150

# Vocal-free musical lead-in (ms) prepended to every phrase clip. The
# backing slice covers this entire range as real song audio, but the
# vocals slice has its first LEAD_IN_MS muted. Result: the user hears
# 2s of just-instrumental backing (real song context) before the vocal
# entry, giving them a beat to ground themselves in the music.
# 0 = no lead-in (matches the pre-existing behavior).
LEAD_IN_MS = 2000

# Phrase boundary heuristic: when a singer takes a breath between lines
# they typically pause >800ms. Tightening this lower (300-500ms) would
# split phrases on every comma's worth of pause — too granular. Looser
# (1.5s+) would merge clearly distinct lines back together.
PHRASE_GAP_MS = 800

# A line phrase is at most MAX_LINE_S of consecutive singing. Keeps the
# practice clip short enough to be memorizable in one pass.
MAX_LINE_S = 10.0
MIN_PHRASE_MS = 500

# Verse grouping (consecutive 3–5 lines, hard-capped at MAX_VERSE_MS).
MAX_VERSE_MS = 22_000
VERSE_MIN_LINES = 3
VERSE_MAX_LINES = 5


def _build_lines(words: list[dict]) -> list[dict]:
    """Group consecutive words into line-phrases by gap-and-length rule."""
    if not words:
        return []

    sorted_words = sorted(words, key=lambda w: w["start"])
    lines: list[list[dict]] = []
    current: list[dict] = []

    def push():
        if current:
            lines.append(list(current))
            current.clear()

    for w in sorted_words:
        if not current:
            current.append(w)
            continue

        gap_ms = (w["start"] - current[-1]["end"]) * 1000
        running_ms = (current[-1]["end"] - current[0]["start"]) * 1000

        if gap_ms >= PHRASE_GAP_MS or running_ms >= MAX_LINE_S * 1000:
            push()
        current.append(w)

    push()

    return [
        {
            "start_ms": int(round(group[0]["start"] * 1000)),
            "end_ms": int(round(group[-1]["end"] * 1000)),
            "words": group,
        }
        for group in lines
    ]


def detect_phrases(
    vocals_path: Path,
    notes: list[dict],
    words: list[dict],
    drums_path: Path | None = None,
) -> list[dict]:
    """Return list of phrase dicts (line + verse types).

    `vocals_path` is unused for boundary detection now (kept for backward
    compatibility with the worker call site); it's still used to compute
    tempo_bpm via librosa beat track on the drums stem when present.
    """
    import librosa
    import numpy as np
    import soundfile as sf

    raw_lines = _build_lines(words)

    def clip_offset(phrase_start_ms: int) -> int:
        # Clip starts CLIP_PAD_MS + LEAD_IN_MS before the phrase's first
        # sung syllable, clamped at song-start.
        return max(0, phrase_start_ms - CLIP_PAD_MS - LEAD_IN_MS)

    def clip_duration(phrase_start_ms: int, phrase_end_ms: int) -> int:
        # Total duration of the audio clip ffmpeg will emit. = lead-in
        # (full LEAD_IN_MS or less for early phrases) + CLIP_PAD_MS +
        # phrase_dur + CLIP_PAD_MS. Used as loopDuration on the client.
        return phrase_end_ms + CLIP_PAD_MS - clip_offset(phrase_start_ms)

    def notes_in_window(start_ms: int, end_ms: int) -> list[dict]:
        clip0 = clip_offset(start_ms)
        sel = [n for n in notes if n["start_ms"] >= start_ms and n["end_ms"] <= end_ms]
        return [
            {**n, "start_ms": n["start_ms"] - clip0, "end_ms": n["end_ms"] - clip0}
            for n in sel
        ]

    lines: list[dict] = []
    for raw in raw_lines:
        start_ms = raw["start_ms"]
        end_ms = raw["end_ms"]
        duration_ms = end_ms - start_ms
        if duration_ms < MIN_PHRASE_MS:
            continue
        lyric_text = " ".join(w["word"] for w in raw["words"] if w.get("word")).strip()
        if not lyric_text:
            continue
        lines.append({
            "start_ms": start_ms,
            "end_ms": end_ms,
            # duration_ms is the full audio-clip length now, including the
            # vocal-free lead-in + CLIP_PAD on each side. The client uses
            # this as loop length so the lead-in plays inside every loop.
            "duration_ms": clip_duration(start_ms, end_ms),
            "phrase_type": "line",
            "lyric_text": lyric_text,
            "notes": notes_in_window(start_ms, end_ms),
        })

    # Tempo estimate from drums (per CLAUDE.md) — fall back to None.
    tempo_bpm: float | None = None
    if drums_path is not None and drums_path.exists():
        try:
            y_d, sr_d = sf.read(str(drums_path))
            if y_d.ndim > 1:
                y_d = y_d.mean(axis=1)
            tempo, _ = librosa.beat.beat_track(y=y_d, sr=sr_d)
            tempo_arr = np.asarray(tempo).ravel()
            if tempo_arr.size > 0:
                tempo_bpm = float(tempo_arr[0])
        except Exception as e:
            print(f"[phrases] tempo_bpm detection failed: {e}")

    for line in lines:
        line["tempo_bpm"] = tempo_bpm

    # Build verse phrases (3–5 consecutive lines, capped at MAX_VERSE_MS).
    verses: list[dict] = []
    i = 0
    while i < len(lines):
        group: list[dict] = []
        j = i
        group_start = lines[i]["start_ms"]
        while j < len(lines):
            if len(group) >= VERSE_MAX_LINES:
                break
            if (lines[j]["end_ms"] - group_start) > MAX_VERSE_MS:
                break
            group.append(lines[j])
            j += 1
        if len(group) >= VERSE_MIN_LINES:
            verse_start = group[0]["start_ms"]
            verse_end = group[-1]["end_ms"]
            verse_clip0 = clip_offset(verse_start)
            verse_notes: list[dict] = []
            for g in group:
                line_clip0 = clip_offset(g["start_ms"])
                offset = line_clip0 - verse_clip0
                for n in g["notes"]:
                    verse_notes.append({
                        **n,
                        "start_ms": n["start_ms"] + offset,
                        "end_ms": n["end_ms"] + offset,
                    })
            verses.append({
                "start_ms": verse_start,
                "end_ms": verse_end,
                "duration_ms": clip_duration(verse_start, verse_end),
                "phrase_type": "verse",
                "lyric_text": " ".join(g["lyric_text"] for g in group if g["lyric_text"]),
                "notes": verse_notes,
                "tempo_bpm": tempo_bpm,
            })
            i += len(group)
        else:
            i += 1

    return lines + verses
