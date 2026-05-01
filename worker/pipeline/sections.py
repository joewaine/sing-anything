"""Structural section detection — replaces arbitrary 3-5-line "verse"
groupings with actual song structure (intro / verse / chorus / bridge /
outro), so practice clips align with how the song is built rather than
sliding 3-line windows.

Pipeline:
  1. Beat-track the full mix.
  2. Beat-sync chroma + MFCC features (chroma captures chord/harmony,
     MFCC captures timbre — together they discriminate verse from chorus
     from bridge much better than either alone).
  3. Agglomerative segmentation → ~25-second average segments.
  4. Cluster segments by cosine similarity of their mean feature vectors
     to find repeats (chorus repeats, sometimes verses do too).
  5. Heuristic labels:
       - First / last segment with low whisper-word density → intro / outro.
       - Most-repeated cluster with high vocal density → chorus.
       - Other vocal segments in chronological order → verse 1, verse 2, ...
       - Mid-song low-vocal non-repeated segment → bridge.

This is intentionally librosa-only (no allin1 / msaf / madmom) — librosa
is already in the worker image, and the heuristic is good enough for the
"play Verse 2 / Chorus" picker UX. Swap in a labeled-segmentation model
later if the labels start feeling consistently off.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

# Cosine-similarity threshold above which two segments are clustered as
# "the same" (so they can both be tagged as chorus, etc.). Tighter values
# (>0.95) miss real chorus repeats with slightly different production;
# looser (<0.85) starts merging verse and chorus together.
SIMILARITY_THRESHOLD = 0.92

# A segment under this is dropped — usually a beat-track misfire or
# the tail end of an outro that the segmenter latched onto.
MIN_SEGMENT_MS = 3000

# Whisper word count under this counts as "low vocal density" — used
# to label intro / outro / instrumental bridges. ~3 words is a clean
# threshold because a typical sung phrase is at least 5 words.
LOW_VOCAL_WORDS = 3

# Average segment length target. Songs of typical length (2.5–4 min)
# end up with 5–9 sections. Bumping this gives fewer, longer sections;
# lowering gives more granular cuts that often split verses in half.
TARGET_SEGMENT_S = 25


def detect_sections(
    mix_path: Path,
    words: list[dict],
    duration_ms: int,
) -> list[dict]:
    """Return labeled sections for the song.

    Output rows: {"start_ms", "end_ms", "label", "index_in_label"}
      - label ∈ {"intro", "verse", "chorus", "bridge", "outro"}
      - index_in_label is 1-based occurrence within that label (so the
        second chorus is index_in_label=2, etc.). Lets the picker
        render "Chorus 2" without doing its own counting.

    Returns [] if the audio is too short or beat tracking fails — caller
    should fall back to its prior heuristic in that case.
    """
    import librosa
    import numpy as np

    if duration_ms < 30_000:
        return []

    try:
        y, sr = librosa.load(str(mix_path), sr=22050, mono=True)
    except Exception as e:
        print(f"[sections] load failed: {e}")
        return []

    if len(y) < sr * 20:
        return []

    hop = 512

    try:
        _, beats = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop)
    except Exception as e:
        print(f"[sections] beat_track failed: {e}")
        return []

    # Need enough beats for meaningful agglomerative clustering. A 3-min
    # song at 120 BPM has ~360 beats — comfortably above this floor.
    if beats is None or len(beats) < 32:
        return []

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=hop)
    features = np.vstack([chroma, mfcc])

    beat_features = librosa.util.sync(features, beats, aggregate=np.mean)

    duration_s = duration_ms / 1000
    n_segments = max(4, min(9, int(round(duration_s / TARGET_SEGMENT_S))))
    if beat_features.shape[1] < n_segments * 2:
        return []

    try:
        seg_starts_idx = librosa.segment.agglomerative(beat_features, k=n_segments)
    except Exception as e:
        print(f"[sections] agglomerative failed: {e}")
        return []

    # seg_starts_idx are indices into beat_features (i.e. beat indices).
    # Map back to original frame indices via `beats`, then to seconds.
    seg_starts_idx = np.asarray(seg_starts_idx, dtype=int)
    seg_starts_idx = seg_starts_idx[seg_starts_idx < len(beats)]
    seg_start_beats = beats[seg_starts_idx]
    seg_start_times = librosa.frames_to_time(seg_start_beats, sr=sr, hop_length=hop)

    # Build [start, end] segments. First segment starts at 0 even if the
    # first detected boundary is later (we don't want to drop the intro).
    boundaries_s = sorted(set([0.0, *seg_start_times.tolist(), duration_s]))
    raw_segments: list[dict] = []
    for i in range(len(boundaries_s) - 1):
        start_ms = int(boundaries_s[i] * 1000)
        end_ms = int(boundaries_s[i + 1] * 1000)
        if end_ms - start_ms < MIN_SEGMENT_MS:
            continue
        raw_segments.append({"start_ms": start_ms, "end_ms": end_ms})

    if not raw_segments:
        return []

    # Mean feature vector per segment — used for similarity clustering
    # to find repeating sections (the most reliable chorus signal).
    seg_features = []
    for seg in raw_segments:
        f0 = librosa.time_to_frames(seg["start_ms"] / 1000.0, sr=sr, hop_length=hop)
        f1 = librosa.time_to_frames(seg["end_ms"] / 1000.0, sr=sr, hop_length=hop)
        f0 = max(0, int(f0))
        f1 = min(features.shape[1], int(f1))
        if f1 <= f0:
            seg_features.append(np.zeros(features.shape[0]))
            continue
        seg_features.append(features[:, f0:f1].mean(axis=1))
    feat_matrix = np.array(seg_features)

    # Cosine similarity between every pair of segments. We DON'T pull
    # sklearn just to do this — the matrix is at most ~9×9.
    norms = np.linalg.norm(feat_matrix, axis=1, keepdims=True) + 1e-9
    normalized = feat_matrix / norms
    sim = normalized @ normalized.T

    # Greedy cluster assignment in original time order. Each unassigned
    # segment seeds a cluster; later segments above the similarity floor
    # join that cluster. Deterministic and easy to reason about.
    cluster_ids = [-1] * len(raw_segments)
    next_cluster = 0
    for i in range(len(raw_segments)):
        if cluster_ids[i] != -1:
            continue
        cluster_ids[i] = next_cluster
        for j in range(i + 1, len(raw_segments)):
            if cluster_ids[j] == -1 and sim[i, j] > SIMILARITY_THRESHOLD:
                cluster_ids[j] = next_cluster
        next_cluster += 1

    # Vocal density per segment.
    word_starts_ms = (
        [w.get("start", 0) * 1000 for w in words] if words else []
    )
    for seg in raw_segments:
        seg["word_count"] = sum(
            1 for s in word_starts_ms if seg["start_ms"] <= s < seg["end_ms"]
        )

    # Identify chorus cluster: most-repeated cluster (count ≥ 2) with
    # high mean vocal density. Falls back to None if nothing repeats —
    # chorusless songs stay verse-only, which is fine.
    cluster_counts: dict[int, int] = {}
    cluster_word_avg: dict[int, list[int]] = {}
    for cid, seg in zip(cluster_ids, raw_segments):
        cluster_counts[cid] = cluster_counts.get(cid, 0) + 1
        cluster_word_avg.setdefault(cid, []).append(seg["word_count"])

    chorus_cluster: int | None = None
    best_score = 0.0
    for cid, count in cluster_counts.items():
        if count < 2:
            continue
        avg_words = float(np.mean(cluster_word_avg[cid])) if cluster_word_avg[cid] else 0
        if avg_words < LOW_VOCAL_WORDS:
            continue
        score = count * avg_words
        if score > best_score:
            best_score = score
            chorus_cluster = cid

    # Label assignment — single pass, chronological so verse/chorus
    # numbering reflects the order the user hears them.
    label_counts: dict[str, int] = {}
    final: list[dict] = []
    last_idx = len(raw_segments) - 1

    for i, (seg, cid) in enumerate(zip(raw_segments, cluster_ids)):
        is_first = i == 0
        is_last = i == last_idx
        low_vocal = seg["word_count"] < LOW_VOCAL_WORDS

        if is_first and low_vocal:
            label = "intro"
        elif is_last and low_vocal:
            label = "outro"
        elif chorus_cluster is not None and cid == chorus_cluster:
            label = "chorus"
        elif low_vocal:
            label = "bridge"
        else:
            label = "verse"

        label_counts[label] = label_counts.get(label, 0) + 1
        final.append(
            {
                "start_ms": seg["start_ms"],
                "end_ms": seg["end_ms"],
                "label": label,
                "index_in_label": label_counts[label],
            }
        )

    return final
