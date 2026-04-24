"""Phrase detection on the vocals stem.

Silence-gap based: any gap ≥400 ms with RMS below -40 dBFS is a phrase
boundary. Long phrases (>15 s) split on the longest internal gap ≥200 ms.
Verses = groupings of 3–5 consecutive lines capped at 22 s.

Note timestamps on the emitted phrases are **relative to the phrase start**,
matching the Sing Beatles contract SessionScreen expects.
"""

from __future__ import annotations

from pathlib import Path

SILENCE_DB = -40.0
GAP_BOUNDARY_S = 0.400
INTERNAL_SPLIT_GAP_S = 0.200
MAX_LINE_S = 15.0
MAX_VERSE_MS = 22_000
VERSE_MIN_LINES = 3
VERSE_MAX_LINES = 5


def detect_phrases(
    vocals_path: Path,
    notes: list[dict],
    words: list[dict],
    drums_path: Path | None = None,
) -> list[dict]:
    """Return list of phrase dicts with line and (optionally) verse entries."""
    import librosa
    import numpy as np
    import soundfile as sf

    y, sr = sf.read(str(vocals_path))
    if y.ndim > 1:
        y = y.mean(axis=1)

    hop_s = 0.010
    frame_len = int(sr * 0.020)
    hop = int(sr * hop_s)
    rms = librosa.feature.rms(y=y, frame_length=frame_len, hop_length=hop).squeeze()
    rms_db = 20.0 * np.log10(np.maximum(rms, 1e-8))
    voiced = rms_db > SILENCE_DB

    def to_ms(frame: int) -> int:
        return int(round(frame * hop_s * 1000))

    # 1. Find raw voiced runs.
    raw_runs: list[tuple[int, int]] = []
    n = len(voiced)
    i = 0
    while i < n:
        if voiced[i]:
            j = i + 1
            while j < n and voiced[j]:
                j += 1
            raw_runs.append((i, j))
            i = j
        else:
            i += 1

    # 2. Merge runs separated by gaps < 400 ms — those are within-phrase breaths.
    gap_frames = int(GAP_BOUNDARY_S / hop_s)
    merged: list[tuple[int, int]] = []
    for seg in raw_runs:
        if merged and (seg[0] - merged[-1][1]) < gap_frames:
            merged[-1] = (merged[-1][0], seg[1])
        else:
            merged.append(seg)

    # 3. Split runs longer than MAX_LINE_S on their longest internal gap.
    line_runs: list[tuple[int, int]] = []
    max_frames = int(MAX_LINE_S / hop_s)
    internal_gap_frames = int(INTERNAL_SPLIT_GAP_S / hop_s)

    for (f0, f1) in merged:
        if (f1 - f0) <= max_frames:
            line_runs.append((f0, f1))
            continue
        # Find the longest internal false-run
        best_start, best_end, best_len = -1, -1, 0
        k = f0
        while k < f1:
            if not voiced[k]:
                m = k
                while m < f1 and not voiced[m]:
                    m += 1
                if (m - k) > best_len and (m - k) >= internal_gap_frames:
                    best_start, best_end, best_len = k, m, m - k
                k = m
            else:
                k += 1
        if best_len > 0:
            mid = (best_start + best_end) // 2
            line_runs.append((f0, mid))
            line_runs.append((mid, f1))
        else:
            # Hard cap — just truncate at MAX_LINE_S.
            line_runs.append((f0, f0 + max_frames))

    # 4. Build line-phrase dicts with note/lyric projection.
    def notes_in_window(start_ms: int, end_ms: int) -> list[dict]:
        sel = [n for n in notes if n["start_ms"] >= start_ms and n["end_ms"] <= end_ms]
        return [
            {**n, "start_ms": n["start_ms"] - start_ms, "end_ms": n["end_ms"] - start_ms}
            for n in sel
        ]

    def words_in_window(start_ms: int, end_ms: int) -> str:
        ws = [
            w["word"]
            for w in words
            if w["start"] * 1000 >= start_ms and w["end"] * 1000 <= end_ms
        ]
        return " ".join(ws).strip()

    lines: list[dict] = []
    for (f0, f1) in line_runs:
        start_ms = to_ms(f0)
        end_ms = to_ms(f1)
        duration_ms = end_ms - start_ms
        if duration_ms < 500:
            continue  # too short to be a phrase
        lyric_text = words_in_window(start_ms, end_ms)
        if not lyric_text:
            continue  # no words detected; probably instrumental bleed
        lines.append({
            "start_ms": start_ms,
            "end_ms": end_ms,
            "duration_ms": duration_ms,
            "phrase_type": "line",
            "lyric_text": lyric_text,
            "notes": notes_in_window(start_ms, end_ms),
        })

    # 5. Tempo estimate from drums (per CLAUDE.md) — fall back to None.
    tempo_bpm: float | None = None
    if drums_path is not None and drums_path.exists():
        try:
            y_d, sr_d = sf.read(str(drums_path))
            if y_d.ndim > 1:
                y_d = y_d.mean(axis=1)
            tempo, _ = librosa.beat.beat_track(y=y_d, sr=sr_d)
            # librosa 0.10.x returns tempo as a 0-dim or 1-element ndarray.
            tempo_arr = np.asarray(tempo).ravel()
            if tempo_arr.size > 0:
                tempo_bpm = float(tempo_arr[0])
        except Exception as e:
            print(f"[phrases] tempo_bpm detection failed: {e}")

    for line in lines:
        line["tempo_bpm"] = tempo_bpm

    # 6. Build verse phrases (3–5 consecutive lines, capped at MAX_VERSE_MS).
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
            verse_notes: list[dict] = []
            for g in group:
                offset = g["start_ms"] - verse_start
                for n in g["notes"]:
                    verse_notes.append({
                        **n,
                        "start_ms": n["start_ms"] + offset,
                        "end_ms": n["end_ms"] + offset,
                    })
            verses.append({
                "start_ms": verse_start,
                "end_ms": verse_end,
                "duration_ms": verse_end - verse_start,
                "phrase_type": "verse",
                "lyric_text": " ".join(g["lyric_text"] for g in group if g["lyric_text"]),
                "notes": verse_notes,
                "tempo_bpm": tempo_bpm,
            })
            i += len(group)
        else:
            i += 1

    return lines + verses
