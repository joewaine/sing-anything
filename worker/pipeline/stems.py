"""Demucs wrapper + backing-mix helper."""

from __future__ import annotations

from pathlib import Path


def run_demucs(original: Path, out_dir: Path, model: str = "htdemucs") -> Path:
    """Split `original` into 4 stems under `out_dir/<model>/<trackname>/*.wav`.

    Returns the per-track stem directory.
    """
    import demucs.separate

    demucs.separate.main([
        "--out", str(out_dir),
        "-n", model,
        str(original),
    ])
    return out_dir / model / original.stem


def mix_backing(stem_dir: Path, out_path: Path) -> None:
    """Sum drums+bass+other into a single WAV, peak-normalized to -0.1 dBFS."""
    import numpy as np
    import soundfile as sf

    drums, sr = sf.read(str(stem_dir / "drums.wav"))
    bass, _ = sf.read(str(stem_dir / "bass.wav"))
    other, _ = sf.read(str(stem_dir / "other.wav"))

    mix = drums + bass + other
    peak = float(np.max(np.abs(mix)))
    if peak > 0.99:
        mix = mix * (0.99 / peak)

    sf.write(str(out_path), mix, sr)
