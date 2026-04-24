"""Pitch-curve → one-note-per-word quantizer.

Simple v1: median MIDI over each word's window. Words without a confident
pitch reading are dropped from the notes list (they still appear in
lyric_text).
"""

from __future__ import annotations


def quantize_notes(pitch: dict, words: list[dict], min_confidence: float = 0.5) -> list[dict]:
    """Return [{start_ms, end_ms, pitch_midi, lyric}, ...] with GLOBAL timestamps."""
    import numpy as np

    times = pitch["times"]
    midis = pitch["midis"]
    confs = pitch["confidences"]

    notes: list[dict] = []
    for w in words:
        start_s, end_s = w["start"], w["end"]
        if end_s - start_s < 0.04:
            continue
        mask = (
            (times >= start_s)
            & (times < end_s)
            & (confs > min_confidence)
            & np.isfinite(midis)
        )
        if mask.sum() < 3:
            continue
        pitch_midi = int(round(float(np.nanmedian(midis[mask]))))
        notes.append({
            "start_ms": int(round(start_s * 1000)),
            "end_ms": int(round(end_s * 1000)),
            "pitch_midi": pitch_midi,
            "lyric": w["word"],
        })
    return notes
