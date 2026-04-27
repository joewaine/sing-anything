"""WhisperX transcription with forced-alignment word timestamps.

Model loads are cached at module scope so warm Modal containers reuse the
loaded ASR + aligner across invocations. Cold start still pays the full
download/load cost once.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

# Module-level caches — Modal reuses the process across warm invocations.
_asr_cache: dict[tuple, Any] = {}
_align_cache: dict[tuple, tuple] = {}


def _get_asr(model_name: str, device: str, compute_type: str):
    import whisperx

    key = (model_name, device, compute_type)
    if key not in _asr_cache:
        _asr_cache[key] = whisperx.load_model(model_name, device, compute_type=compute_type)
    return _asr_cache[key]


def _get_aligner(language: str, device: str):
    import whisperx

    key = (language, device)
    if key not in _align_cache:
        _align_cache[key] = whisperx.load_align_model(language_code=language, device=device)
    return _align_cache[key]


def transcribe_words(
    vocals_path: Path,
    model_name: str = "large-v3",
    audio: Any | None = None,
) -> tuple[str, list[dict]]:
    """Run Whisper + wav2vec2 forced alignment.

    Returns (detected_language, words). Each word:
        {"start": float seconds, "end": float seconds, "word": str, "score": float}

    Optional `audio`: pre-loaded float32 mono numpy array at 16 kHz (whisperx's
    expected shape). Pass it when the orchestrator has already decoded the
    file so we don't pay decode twice. If absent, fall back to disk load.
    """
    import torch
    import whisperx

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"

    asr = _get_asr(model_name, device, compute_type)
    if audio is None:
        audio = whisperx.load_audio(str(vocals_path))
    # Force English — whisper's first-segment language detection can flip
    # to non-English on sparse vocal stems (observed `ru` on a Gerry Rafferty
    # clip), which then loads the wrong wav2vec2 aligner and produces
    # garbled timestamps. When we want multi-language support we should
    # expose this as a per-song setting rather than rely on auto-detection.
    result = asr.transcribe(audio, batch_size=16, language="en")
    language = result.get("language", "en")

    align_model, metadata = _get_aligner(language, device)
    aligned = whisperx.align(
        result["segments"],
        align_model,
        metadata,
        audio,
        device,
        return_char_alignments=False,
    )

    words: list[dict] = []
    for seg in aligned.get("segments", []):
        for w in seg.get("words", []):
            if "start" not in w or "end" not in w:
                continue
            words.append({
                "start": float(w["start"]),
                "end": float(w["end"]),
                "word": str(w.get("word", "")).strip(),
                "score": float(w.get("score", 0.0)),
            })

    return language, words
