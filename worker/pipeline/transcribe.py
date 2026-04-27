"""WhisperX transcription with forced-alignment word timestamps.

Model loads are cached at module scope so warm Modal containers reuse the
loaded ASR + aligner across invocations. Cold start still pays the full
download/load cost once.

Tuned for SUNG vocals, not speech:
  - VAD thresholds are lowered so breathy / quiet / sustained-vowel
    phrases don't get masked as silence and skipped by Whisper.
  - Alignment uses the LARGE wav2vec2 model (vs. the default base 960h)
    because sung vowels stretch well past what the base model was
    trained on.
  - When alignment fails for individual words we fall back to linearly
    interpolated timestamps within the parent segment instead of
    silently dropping the word.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

# Module-level caches — Modal reuses the process across warm invocations.
_asr_cache: dict[tuple, Any] = {}
_align_cache: dict[tuple, tuple] = {}

# Per-language preferred align model. Larger LV60K-960H model is far more
# accurate on sung English than the default base 960h. Falling back to
# whisperx's default if the larger one fails to load (rare — torchaudio
# ships the bundle, just guards against future API churn).
PREFERRED_ALIGN_MODEL = {
    "en": "WAV2VEC2_ASR_LARGE_LV60K_960H",
}

# More permissive VAD than whisperx's defaults (0.500 / 0.363). Sung
# vocals often dip below the speech-trained pyannote VAD threshold mid-
# phrase, especially on breathy or sustained-vowel sections, and the
# whole sub-phrase gets skipped by the ASR. Lower onset/offset captures
# more quiet audio at the cost of slightly more "no speech" frames
# entering Whisper — which is fine, Whisper handles those gracefully.
VAD_OPTIONS = {"vad_onset": 0.300, "vad_offset": 0.200}


def _get_asr(model_name: str, device: str, compute_type: str):
    import whisperx

    key = (model_name, device, compute_type)
    if key not in _asr_cache:
        # asr_options bumps decoding quality:
        #   beam_size=5 — better accuracy on ambiguous tokens (greedy
        #     decoding is the default and misses sung melismas often)
        #   temperatures fallback — try multiple temps before giving up
        #     on a chunk. Default is [0.0, 0.2, ...] in faster-whisper;
        #     we set explicitly to be sure.
        asr_options = {
            "beam_size": 5,
            "temperatures": [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
            # No "no speech" penalty: don't bias against the ASR keeping
            # quiet sung sections in the output.
            "no_speech_threshold": 0.4,
        }
        try:
            _asr_cache[key] = whisperx.load_model(
                model_name,
                device,
                compute_type=compute_type,
                asr_options=asr_options,
                vad_options=VAD_OPTIONS,
            )
        except TypeError:
            # Older whisperx signatures don't take asr_options/vad_options
            # at load_model time — they passed them on transcribe instead.
            _asr_cache[key] = whisperx.load_model(
                model_name,
                device,
                compute_type=compute_type,
            )
    return _asr_cache[key]


def _get_aligner(language: str, device: str):
    import whisperx

    key = (language, device)
    if key in _align_cache:
        return _align_cache[key]

    preferred = PREFERRED_ALIGN_MODEL.get(language)
    if preferred:
        try:
            _align_cache[key] = whisperx.load_align_model(
                language_code=language,
                device=device,
                model_name=preferred,
            )
            print(f"[transcribe] aligner loaded: {preferred}")
            return _align_cache[key]
        except Exception as e:
            print(f"[transcribe] preferred aligner {preferred} failed ({e}); falling back to default")

    _align_cache[key] = whisperx.load_align_model(
        language_code=language,
        device=device,
    )
    return _align_cache[key]


def _interpolate_word_timestamps(seg: dict) -> list[dict]:
    """If wav2vec2 alignment dropped timestamps for some words in a
    segment, fill them in by spreading the segment's start..end across
    the remaining words. Preserves Whisper's word text — only adds
    approximate timing — so words don't silently disappear.
    """
    words = seg.get("words") or []
    if not words:
        return []

    seg_start = float(seg.get("start", 0.0))
    seg_end = float(seg.get("end", seg_start))
    if seg_end <= seg_start:
        seg_end = seg_start + max(0.001, len(words) * 0.2)

    out: list[dict] = []
    for i, w in enumerate(words):
        text = str(w.get("word", "")).strip()
        if not text:
            continue
        ws = w.get("start")
        we = w.get("end")
        if ws is None or we is None:
            # Spread missing words evenly across the segment span.
            frac0 = i / max(1, len(words))
            frac1 = (i + 1) / max(1, len(words))
            ws = seg_start + frac0 * (seg_end - seg_start)
            we = seg_start + frac1 * (seg_end - seg_start)
        out.append({
            "start": float(ws),
            "end": float(we),
            "word": text,
            "score": float(w.get("score", 0.0)),
        })
    return out


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
    # to non-English on sparse vocal stems (observed `ru` on a Gerry
    # Rafferty clip), which then loads the wrong wav2vec2 aligner and
    # produces garbled timestamps. Multi-language support should be a
    # per-song setting rather than auto-detect.
    result = asr.transcribe(
        audio,
        batch_size=16,
        language="en",
        # 20s chunks (default 30) shorten the boundary-merge window — fewer
        # cases where a phrase straddling a chunk break gets clipped.
        chunk_size=20,
    )
    language = result.get("language", "en")

    raw_word_count = sum(
        len((seg.get("text") or "").split()) for seg in (result.get("segments") or [])
    )

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
        words.extend(_interpolate_word_timestamps(seg))

    print(
        f"[transcribe] whisper raw words≈{raw_word_count}  aligned={len(words)}  "
        f"(drop={max(0, raw_word_count - len(words))})"
    )

    return language, words
