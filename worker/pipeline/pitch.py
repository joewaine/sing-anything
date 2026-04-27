"""Pitch tracking on the vocals stem via torchcrepe (full model)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

# 10 ms hop at 16 kHz — CREPE's canonical frame rate.
HOP_LENGTH = 160
SAMPLE_RATE = 16_000
FMIN = 50.0
FMAX = 1100.0


def pitch_curve(vocals_path: Path, audio_16k: Any | None = None) -> dict:
    """Return {"times": sec (T,), "midis": float (T,), "confidences": (T,)}.

    Optional `audio_16k`: float32 mono numpy array at 16 kHz (the shape
    whisperx.load_audio returns). Reusing it skips a second torchaudio
    decode + resample of the same file.
    """
    import numpy as np
    import torch
    import torchaudio
    import torchcrepe

    if audio_16k is not None:
        # numpy 1-D float32 → torch (1, T)
        audio = torch.from_numpy(np.ascontiguousarray(audio_16k, dtype=np.float32))
        if audio.dim() == 1:
            audio = audio.unsqueeze(0)
    else:
        audio, sr = torchaudio.load(str(vocals_path))
        if audio.shape[0] > 1:
            audio = audio.mean(dim=0, keepdim=True)
        if sr != SAMPLE_RATE:
            audio = torchaudio.functional.resample(audio, sr, SAMPLE_RATE)

    device = "cuda" if torch.cuda.is_available() else "cpu"

    # Drop torchcrepe batch_size 2048 → 1024 to halve VRAM peak. Lets it
    # share the GPU with whisperx large-v3 fp16 in the parallelized path.
    pitch_hz, periodicity = torchcrepe.predict(
        audio.to(device),
        SAMPLE_RATE,
        HOP_LENGTH,
        FMIN,
        FMAX,
        model="full",
        batch_size=1024,
        device=device,
        return_periodicity=True,
    )

    pitch_hz = pitch_hz.squeeze(0).cpu().numpy()
    periodicity = periodicity.squeeze(0).cpu().numpy()
    times = np.arange(pitch_hz.shape[0]) * (HOP_LENGTH / SAMPLE_RATE)

    with np.errstate(divide="ignore", invalid="ignore"):
        midis = 69.0 + 12.0 * np.log2(pitch_hz / 440.0)
    midis = np.where(pitch_hz > 0, midis, np.nan)

    return {"times": times, "midis": midis, "confidences": periodicity}
