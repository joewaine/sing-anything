"""Pitch-curve → notes. Splits each whisper word into one or more notes
based on intra-word pitch movement.

Why split: a sung word like "love-uh-uh-uh" (melisma) moves pitch within
one syllable. The earlier "one note per word" simplification flattened
all that into a single median, which made the piano roll lie about the
melody. We now sample the word's pitch curve in stable runs and emit a
fresh note whenever pitch shifts ≥ NOTE_SPLIT_SEMITONES.

Outputs are still in GLOBAL ms (relative to original audio); phrases.py
projects them to clip-relative time before persistence.
"""

from __future__ import annotations

# A run of voiced frames where the median pitch differs from the
# previous note's pitch by at least this many semitones starts a new
# note. Lower = more notes (truer to melisma but noisier on vibrato).
# Higher = fewer notes (cleaner but flattens melody).
NOTE_SPLIT_SEMITONES = 1.5

# Minimum length (ms) for a note. Below this, runs are merged into the
# adjacent note instead of emitted as standalone — keeps vibrato wiggles
# from cluttering the piano roll.
MIN_NOTE_MS = 120

# Minimum confident-pitch frames inside a run before we'll trust it.
MIN_FRAMES_PER_NOTE = 3


def quantize_notes(pitch: dict, words: list[dict], min_confidence: float = 0.5) -> list[dict]:
    """Return [{start_ms, end_ms, pitch_midi, lyric}, ...] in global ms.

    Each whisper word becomes 1+ notes depending on intra-word pitch
    motion. Word lyric is attached to the first emitted note; subsequent
    notes from the same word inherit '' so the piano roll labels each
    syllable once at its onset.
    """
    import numpy as np

    times = pitch["times"]
    midis = pitch["midis"]
    confs = pitch["confidences"]

    notes: list[dict] = []
    # Track the most-recent emitted note's pitch so we can fall back to it
    # when a word's pitch window is too short or too unconfident to trust.
    # Without this, any word that lyrics_verify inserted via LRCLIB merge
    # would silently disappear if its synthesized [start,end] happened to
    # land on an instrumental gap. With it, the lyric reliably surfaces in
    # the strip even when the underlying pitch is murky.
    last_pitch: int | None = None

    def _emit_stub(word: dict) -> None:
        if last_pitch is None:
            return
        notes.append({
            "start_ms": int(round(word["start"] * 1000)),
            "end_ms": int(round(word["end"] * 1000)),
            "pitch_midi": last_pitch,
            "lyric": word.get("word", ""),
        })

    for w in words:
        start_s, end_s = w["start"], w["end"]
        if end_s - start_s < 0.04:
            continue

        i0 = int(np.searchsorted(times, start_s, side="left"))
        i1 = int(np.searchsorted(times, end_s, side="left"))
        if i1 - i0 < MIN_FRAMES_PER_NOTE:
            _emit_stub(w)
            continue

        m_slice = midis[i0:i1]
        c_slice = confs[i0:i1]
        t_slice = times[i0:i1]
        good = (c_slice > min_confidence) & np.isfinite(m_slice)
        if good.sum() < MIN_FRAMES_PER_NOTE:
            _emit_stub(w)
            continue

        # Walk the word's frames; whenever the running median deviates by
        # NOTE_SPLIT_SEMITONES from the segment we're building, close the
        # current note and start a new one.
        sub_notes: list[tuple[float, float, int]] = []  # (start_s, end_s, midi)
        seg_pitches: list[float] = []
        seg_start_s = float(t_slice[0])
        seg_end_s = seg_start_s

        def _flush():
            if not seg_pitches:
                return
            midi = int(round(float(np.nanmedian(seg_pitches))))
            sub_notes.append((seg_start_s, seg_end_s, midi))

        for k in range(len(m_slice)):
            if not good[k]:
                # Voiced gap inside the word — extend current segment's
                # end without contributing a sample.
                seg_end_s = float(t_slice[k])
                continue
            p = float(m_slice[k])
            t = float(t_slice[k])
            if not seg_pitches:
                seg_pitches = [p]
                seg_start_s = t
                seg_end_s = t
                continue
            running_median = float(np.nanmedian(seg_pitches))
            if abs(p - running_median) >= NOTE_SPLIT_SEMITONES:
                # Pitch jumped — close prior segment, start a new one.
                _flush()
                seg_pitches = [p]
                seg_start_s = t
                seg_end_s = t
            else:
                seg_pitches.append(p)
                seg_end_s = t
        _flush()

        if not sub_notes:
            _emit_stub(w)
            continue

        # Merge any sub-notes shorter than MIN_NOTE_MS into a neighbor.
        merged: list[tuple[float, float, int]] = []
        for sub in sub_notes:
            ss, se, sm = sub
            length_ms = (se - ss) * 1000
            if length_ms < MIN_NOTE_MS and merged:
                # Merge into previous: extend its end + recompute via
                # weighted average pitch.
                ps, pe, pm = merged[-1]
                # Recompute combined median: weight by frame count proxy
                # = duration. Cheap approximation that avoids re-fetching
                # the original frames.
                pw = max(1, int(round((pe - ps) * 1000)))
                cw = max(1, int(round(length_ms)))
                merged[-1] = (
                    ps,
                    se,
                    int(round((pm * pw + sm * cw) / (pw + cw))),
                )
            else:
                merged.append(sub)

        for idx, (ss, se, sm) in enumerate(merged):
            notes.append({
                "start_ms": int(round(ss * 1000)),
                "end_ms": int(round(se * 1000)),
                "pitch_midi": sm,
                # Only the first note of the word carries the lyric so
                # the piano roll/lyric strip don't show duplicates on
                # melisma splits.
                "lyric": w["word"] if idx == 0 else "",
            })
            last_pitch = sm

    return notes
