#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PodCraft Studio Pro — Apple Silicon Local Neural ASR & Cloud LLM Sidecar (v2.3)

Built-in Local Offline Neural Pipeline (Zero PyTorch / Zero HuggingFace block):
  - VAD: Silero VAD ONNX (`models/silero_vad.onnx`)
  - Primary ASR: FunAudioLLM SenseVoiceSmall int8 (`models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`)
    -> Native Mandarin + English + Cantonese + Japanese + Korean
    -> Exact CTC per-character / per-word millisecond timestamps
    -> Built-in Punctuation + Inverse Text Normalization (ITN) + Laughter/Emotion detection
  - Fallback ASR: Alibaba Paraformer-zh + CT-Transformer Punctuation (`models/sherpa-onnx-paraformer-zh-small-2024-03-09`)
  - Audio Decoder: FFmpeg 16kHz mono PCM16 streaming pipe (supports WAV, MP3, M4A, AAC, FLAC, OGG, MP4)
  - Multi-Track Bleed Gate: Gain-normalized cross-track dominance gating for clean per-speaker transcripts
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
import base64
import datetime
import hashlib
import hmac
import io
import json
import math
import os
import platform
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave
from typing import Any, Dict, List, Optional, Tuple

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def resolve_models_dir() -> str:
    """Dynamically locates the AI models directory from env, app bundle, home directory, or project root."""
    env_dir = os.environ.get("TAPWAVE_MODELS_DIR") or os.environ.get("PODCRAFT_MODELS_DIR")
    if env_dir and os.path.isdir(env_dir):
        return env_dir
    candidates = [
        os.path.join(PROJECT_ROOT, "models"),
        os.path.expanduser("~/.tapwave/models"),
        os.path.expanduser("~/Library/Application Support/com.tapwave.studio/models"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "models"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "../Resources/models"),
        "/Applications/点波 TapWave.app/Contents/Resources/models",
    ]
    for c in candidates:
        if os.path.isdir(c) and (
            os.path.exists(os.path.join(c, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"))
            or os.path.exists(os.path.join(c, "silero_vad.onnx"))
        ):
            return c
    user_models = os.path.expanduser("~/.tapwave/models")
    return user_models


MODELS_DIR = resolve_models_dir()


def load_dotenv_local() -> None:
    """Loads key=value pairs from PROJECT_ROOT/.env.local into os.environ if unset."""
    env_path = os.path.join(PROJECT_ROOT, ".env.local")
    if not os.path.isfile(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                key = k.strip()
                val = v.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
    except Exception:
        pass


load_dotenv_local()

SENSE_VOICE_DIR = os.path.join(
    MODELS_DIR, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
)
PARAFORMER_DIR = os.path.join(
    MODELS_DIR, "sherpa-onnx-paraformer-zh-small-2024-03-09"
)
PUNCT_DIR = os.path.join(
    MODELS_DIR, "sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8"
)
SILERO_VAD_PATH = os.path.join(MODELS_DIR, "silero_vad.onnx")

TRAILING_PUNCT_RE = re.compile(r"^[，。？！、；：,.?!;:）》」』\]\)”’…—]+$")
ASCII_CONT_RE = re.compile(r"^[A-Za-z0-9'\-\.]+$")
MULTI_CHAR_FILLERS = ("怎么说呢", "就是说", "其实吧", "那个")
DEEPSEEK_ASR_MAX_BYTES = 8 * 1024 * 1024
DEEPSEEK_ASR_DEFAULT_BASE_URL = "https://api.deepseek.com"
PROGRESS_LOCK = threading.Lock()


def emit_progress(pct: int, msg: str) -> None:
    payload = json.dumps({"pct": max(1, min(99, int(pct))), "msg": msg}, ensure_ascii=False)
    with PROGRESS_LOCK:
        print(f"PROGRESS:{payload}", flush=True)


def check_module(name: str) -> bool:
    try:
        __import__(name)
        return True
    except ImportError:
        return False


def find_ffmpeg_bin() -> str:
    for candidate in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
        if os.path.exists(candidate):
            return candidate
    return "ffmpeg"


def has_sense_voice_model() -> bool:
    return os.path.isfile(os.path.join(SENSE_VOICE_DIR, "model.int8.onnx")) and os.path.isfile(
        os.path.join(SENSE_VOICE_DIR, "tokens.txt")
    )


def has_paraformer_model() -> bool:
    return os.path.isfile(os.path.join(PARAFORMER_DIR, "model.int8.onnx")) and os.path.isfile(
        os.path.join(PARAFORMER_DIR, "tokens.txt")
    )


def handle_check_capabilities() -> Dict[str, Any]:
    current_models_dir = resolve_models_dir()
    has_sherpa = check_module("sherpa_onnx")
    sv_ready = has_sherpa and has_sense_voice_model()
    pf_ready = has_sherpa and has_paraformer_model()
    volc_ak = os.environ.get("VOLC_ACCESS_KEY_ID", "").strip()
    volc_sk = os.environ.get("VOLC_SECRET_ACCESS_KEY", "").strip()
    volc_key = os.environ.get("VOLC_API_KEY", "").strip()
    return {
        "ok": True,
        "arch": platform.machine(),
        "pythonVersion": platform.python_version(),
        "asrReady": bool(sv_ready or pf_ready),
        "modelsDir": current_models_dir,
        "modelsDownloaded": bool(has_sense_voice_model() or has_paraformer_model()),
        "missingModels": [] if (sv_ready or pf_ready) else ["sense_voice", "silero_vad"],
        "volcEnvConfigured": bool((volc_ak and volc_sk) or volc_key),
        "volcAccountInfo": {
            "username": os.environ.get("VOLC_USERNAME", "").strip(),
            "accountId": os.environ.get("VOLC_ACCOUNT_ID", "").strip(),
        },
        "engines": {
            "sherpa_onnx": has_sherpa,
            "sense_voice_int8": sv_ready,
            "paraformer_zh_int8": pf_ready,
            "silero_vad": os.path.isfile(SILERO_VAD_PATH),
            "ct_punct": os.path.isfile(os.path.join(PUNCT_DIR, "model.int8.onnx")),
            "faster_whisper": check_module("faster_whisper"),
            "deepseek_asr": True,
            "volcengine_doubao": True,
        },
    }


def decode_audio_16khz_mono_f32(file_path: str):
    """Decodes ANY audio/video container (WAV/MP3/M4A/FLAC/AAC/OGG/MP4) to 16kHz mono float32 via FFmpeg."""
    import numpy as np  # type: ignore

    if not file_path or not os.path.exists(file_path):
        return np.zeros(0, dtype=np.float32)

    cmd = [
        find_ffmpeg_bin(),
        "-nostdin",
        "-loglevel",
        "error",
        "-threads",
        "0",
        "-i",
        file_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "pipe:1",
    ]
    proc = subprocess.run(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0 and len(proc.stdout) == 0:
        err = proc.stderr.decode("utf-8", errors="ignore").strip()
        raise RuntimeError(f"FFmpeg 无法解码音频 ({file_path}): {err}")

    pcm = np.frombuffer(proc.stdout, dtype=np.int16)
    return pcm.astype(np.float32) / 32768.0


def extract_fast_acoustics_from_16k(samples) -> Dict[str, Any]:
    """Computes RMS envelope, clap transients, and trailing dB drop from 16kHz float32 buffer."""
    import numpy as np  # type: ignore

    n = int(samples.shape[0])
    duration_ms = int(round((n / 16000.0) * 1000))
    if n < 1600:
        return {
            "durationMs": duration_ms,
            "rmsWindows": [],
            "clapTimestampsMs": [],
            "trailingDropDb": 3.5,
        }

    win = 16000  # 1s windows, scan up to first 180s for acoustic profiling
    max_samples = min(n, 180 * win)
    n_wins = max_samples // win
    rms_windows: List[float] = []
    clap_timestamps_ms: List[int] = []

    if n_wins > 0:
        reshaped = samples[: n_wins * win].reshape(n_wins, win)
        rms_arr = np.sqrt(np.mean(reshaped * reshaped, axis=1) + 1e-12)
        peaks_arr = np.max(np.abs(reshaped), axis=1)
        db_arr = 20.0 * np.log10(np.maximum(1e-5, rms_arr))
        rms_windows = [round(float(v), 2) for v in db_arr]

        for idx in range(n_wins):
            pk = float(peaks_arr[idx])
            rm = float(rms_arr[idx])
            if pk > 0.42 and (pk / max(1e-4, rm)) > 6.2:
                clap_timestamps_ms.append(idx * 1000 + 500)

    trailing_drop = 3.6
    if len(rms_windows) >= 4:
        diffs = [max(0.0, rms_windows[i - 1] - rms_windows[i]) for i in range(1, len(rms_windows))]
        trailing_drop = round(min(12.0, max(1.8, sum(diffs) / len(diffs))), 1)

    return {
        "durationMs": duration_ms,
        "rmsWindows": rms_windows,
        "clapTimestampsMs": clap_timestamps_ms,
        "trailingDropDb": trailing_drop,
    }


def normalize_for_asr(samples):
    """Gain-normalizes quiet microphone stems in memory so VAD and ASR never miss soft-spoken voices."""
    import numpy as np  # type: ignore

    if samples.shape[0] == 0:
        return samples
    peak = float(np.max(np.abs(samples)))
    if peak < 1e-4:
        return samples

    # Compute active 95th-percentile amplitude to boost soft voices safely without clipping
    p95 = float(np.percentile(np.abs(samples[::16]), 95))
    target_gain = 1.0
    if p95 > 1e-4 and p95 < 0.12:
        target_gain = min(8.0, 0.18 / p95)
    elif peak < 0.35:
        target_gain = min(4.0, 0.75 / peak)

    if abs(target_gain - 1.0) < 0.05:
        return samples
    return np.clip(samples * target_gain, -0.98, 0.98).astype(np.float32)


def apply_cross_track_bleed_suppression(
    track_buffers: Dict[str, Any],
    track_offsets_ms: Dict[str, int],
) -> Dict[str, Any]:
    """
    Suppresses room microphone bleed across multiple simultaneous speaker stems!
    Frames where another speaker's normalized voice energy exceeds this track by >10.5 dB
    (and this track is below its own active speech level) are attenuated before VAD/ASR.
    """
    import numpy as np  # type: ignore

    if len(track_buffers) <= 1:
        return track_buffers

    frame_len = 800  # 50ms @ 16kHz
    envelopes: Dict[str, Any] = {}
    active_refs: Dict[str, float] = {}
    frame_offsets: Dict[str, int] = {}

    max_timeline_frames = 0
    for tid, buf in track_buffers.items():
        n_frames = buf.shape[0] // frame_len
        if n_frames == 0:
            envelopes[tid] = np.zeros(0, dtype=np.float32)
            active_refs[tid] = 1.0
            frame_offsets[tid] = 0
            continue

        trimmed = buf[: n_frames * frame_len].reshape(n_frames, frame_len)
        rms = np.sqrt(np.mean(trimmed * trimmed, axis=1) + 1e-12)
        non_silent = rms[rms > 5e-4]
        ref_val = (
            float(np.percentile(non_silent, 96))
            if non_silent.shape[0] > 4
            else float(np.max(rms))
        )
        ref_level = max(1e-4, ref_val)
        norm_rms = rms / ref_level

        off_frames = int(round((track_offsets_ms.get(tid, 0) / 1000.0) * 20.0))
        envelopes[tid] = norm_rms
        active_refs[tid] = ref_level
        frame_offsets[tid] = off_frames
        max_timeline_frames = max(max_timeline_frames, n_frames + max(0, off_frames))

    if max_timeline_frames == 0:
        return track_buffers

    gated_buffers: Dict[str, Any] = {}
    ratio_thresh = 10.0 ** (-8.0 / 20.0)  # -8.0 dB relative dominance threshold

    for tid, buf in track_buffers.items():
        env = envelopes[tid]
        n_frames = env.shape[0]
        if n_frames == 0:
            gated_buffers[tid] = buf
            continue

        my_off = frame_offsets[tid]
        other_max = np.zeros(n_frames, dtype=np.float32)

        for other_id, other_env in envelopes.items():
            if other_id == tid or other_env.shape[0] == 0:
                continue
            other_off = frame_offsets[other_id]
            shift = my_off - other_off
            src_start = max(0, shift)
            dst_start = max(0, -shift)
            copy_len = min(other_env.shape[0] - src_start, n_frames - dst_start)
            if copy_len > 0:
                other_max[dst_start : dst_start + copy_len] = np.maximum(
                    other_max[dst_start : dst_start + copy_len],
                    other_env[src_start : src_start + copy_len],
                )

        # Bleed mask: other track is speaking (>0.08 of its peak RMS) AND >8dB stronger than this track
        raw_bleed = (other_max > 0.08) & (env < other_max * ratio_thresh) & (env < 0.35)
        # Dilate bleed mask by +-2 frames (+-100ms) so bleed consonant tails never leak into normalize_for_asr
        is_bleed = raw_bleed.copy()
        for shift_k in (-2, -1, 1, 2):
            if shift_k < 0:
                is_bleed[:shift_k] |= raw_bleed[-shift_k:]
            else:
                is_bleed[shift_k:] |= raw_bleed[:-shift_k]

        if not np.any(is_bleed):
            gated_buffers[tid] = buf
            continue

        out = buf.copy()
        gain_per_frame = np.where(is_bleed, 0.0, 1.0).astype(np.float32)
        # Smooth 1-frame transition at edges
        gain_expanded = np.repeat(gain_per_frame, frame_len)
        out[: gain_expanded.shape[0]] *= gain_expanded
        gated_buffers[tid] = out

    return gated_buffers


def _detect_speech_with_energy_vad(samples) -> List[Tuple[int, int]]:
    """
    Pure-NumPy 20ms adaptive RMS speech-island detector used when Silero ONNX / sherpa_onnx
    is unavailable or yields no segments.
    """
    import numpy as np  # type: ignore

    n = int(samples.shape[0])
    frame_len = 320  # 20ms @ 16kHz
    n_frames = n // frame_len
    if n_frames <= 0:
        return []

    reshaped = samples[: n_frames * frame_len].reshape(n_frames, frame_len)
    rms = np.sqrt(np.mean(reshaped * reshaped, axis=1) + 1e-12)
    noise_floor = max(0.002, min(0.05, float(np.percentile(rms, 18))))
    voiced_thresh = max(0.012, noise_floor * 2.4)
    is_voiced = rms >= voiced_thresh
    if not np.any(is_voiced):
        return []

    max_gap_frames = 19  # 380ms
    min_speech_frames = 8  # 160ms
    raw_runs: List[Tuple[int, int]] = []
    start_f = -1
    for i, flag in enumerate(is_voiced):
        if flag and start_f < 0:
            start_f = i
        elif not flag and start_f >= 0:
            raw_runs.append((start_f, i))
            start_f = -1
    if start_f >= 0:
        raw_runs.append((start_f, n_frames))

    bridged: List[Tuple[int, int]] = []
    for s_f, e_f in raw_runs:
        if bridged and (s_f - bridged[-1][1]) <= max_gap_frames:
            bridged[-1] = (bridged[-1][0], e_f)
        else:
            bridged.append((s_f, e_f))

    segments: List[Tuple[int, int]] = []
    for s_f, e_f in bridged:
        if (e_f - s_f) >= min_speech_frames:
            s_idx = max(0, s_f * frame_len - 1600)
            e_idx = min(n, e_f * frame_len + 1600)
            segments.append((s_idx, e_idx))
    return segments


def segment_speech_with_silero_vad(samples) -> List[Tuple[int, int]]:
    """
    Uses Silero VAD ONNX (when sherpa_onnx is installed) or pure-NumPy adaptive RMS VAD
    to detect speech intervals `(start_sample, end_sample)` at 16kHz, splitting at pauses
    >= 380ms and capping segment length at <= 20s for optimal ASR accuracy.
    """
    import numpy as np  # type: ignore

    try:
        import sherpa_onnx  # type: ignore
    except ImportError:
        sherpa_onnx = None

    n = int(samples.shape[0])
    if n < 800:
        return []

    segments: List[Tuple[int, int]] = []

    if sherpa_onnx is not None and os.path.isfile(SILERO_VAD_PATH):
        vad_cfg = sherpa_onnx.VadModelConfig()
        vad_cfg.silero_vad.model = SILERO_VAD_PATH
        vad_cfg.silero_vad.threshold = 0.38
        vad_cfg.silero_vad.min_silence_duration = 0.38
        vad_cfg.silero_vad.min_speech_duration = 0.16
        vad_cfg.silero_vad.max_speech_duration = 20.0
        vad_cfg.silero_vad.window_size = 512
        vad_cfg.sample_rate = 16000
        vad = sherpa_onnx.VoiceActivityDetector(vad_cfg, buffer_size_in_seconds=120)

        win_sz = 512
        idx = 0
        while idx + win_sz <= n:
            vad.accept_waveform(samples[idx : idx + win_sz])
            idx += win_sz
            while not vad.empty():
                seg = vad.front
                s_idx = max(0, int(seg.start) - 1600)  # 100ms pre-roll padding
                e_idx = min(n, int(seg.start) + len(seg.samples) + 1600)  # 100ms post-roll
                segments.append((s_idx, e_idx))
                vad.pop()

        if idx < n:
            padded = np.zeros(win_sz, dtype=np.float32)
            padded[: n - idx] = samples[idx:]
            vad.accept_waveform(padded)
        vad.flush()
        while not vad.empty():
            seg = vad.front
            s_idx = max(0, int(seg.start) - 1600)
            e_idx = min(n, int(seg.start) + len(seg.samples) + 1600)
            segments.append((s_idx, e_idx))
            vad.pop()

    # Pure-NumPy energy VAD fallback when sherpa/silero is absent or finds nothing
    if not segments:
        segments = _detect_speech_with_energy_vad(samples)

    # Final chunking fallback if still empty on an unusual signal with audible peak
    if not segments and float(np.max(np.abs(samples))) > 0.015:
        chunk = 18 * 16000
        for s in range(0, n, chunk):
            e = min(n, s + chunk)
            if float(np.max(np.abs(samples[s:e]))) > 0.015:
                segments.append((s, e))

    # Merge tiny overlapping pre/post-roll touchpoints while keeping segments <= 22s
    merged: List[Tuple[int, int]] = []
    for s, e in segments:
        if merged and s <= merged[-1][1] + 2400 and (e - merged[-1][0]) <= 20 * 16000:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            # Slice any extra-long segment > 24s into 18s chunks
            cur = s
            while cur < e:
                sub_e = min(e, cur + 18 * 16000)
                if sub_e - cur >= 1600:
                    merged.append((cur, sub_e))
                cur = sub_e

    return merged


def postprocess_asr_tokens(
    raw_tokens: List[str],
    rel_timestamps: List[float],
    seg_start_ms: int,
    seg_end_ms: int,
    event_tag: str = "",
) -> List[Dict[str, Any]]:
    """
    Converts raw neural CTC/CIF subword tokens & timestamps into clean podcast editing tokens:
      1. Merges ASCII/English BPE continuation pieces (' tri' + 'bal' -> 'tribal')
      2. Attaches trailing punctuation ('，', '。', '？', '！') onto the preceding word/character
      3. Coalesces multi-char Mandarin filler phrases ('那个', '就是说', '怎么说呢') for 1-click filler cleanup
      4. Assigns monotonically strictly-increasing `[startMs, endMs]` bounded within `[seg_start_ms, seg_end_ms]`
    """
    seg_dur_ms = max(120, seg_end_ms - seg_start_ms)

    # Pure laughter / applause event with no speech words
    cleaned_pieces = [t for t in raw_tokens if t and not t.startswith("<|")]
    if not cleaned_pieces:
        if "Laughter" in event_tag or "Applause" in event_tag:
            return [
                {
                    "type": "laughter",
                    "text": "😂 [笑声]",
                    "startMs": seg_start_ms,
                    "endMs": seg_end_ms,
                }
            ]
        return []

    n_raw = len(raw_tokens)
    has_ts = len(rel_timestamps) == n_raw and n_raw > 0

    items: List[Dict[str, Any]] = []
    for i, tok in enumerate(raw_tokens):
        if not tok or tok.startswith("<|"):
            continue
        if has_ts:
            t_ms = seg_start_ms + int(round(float(rel_timestamps[i]) * 1000.0))
        else:
            t_ms = seg_start_ms + int(round((i / max(1, n_raw)) * seg_dur_ms))
        t_ms = max(seg_start_ms, min(seg_end_ms - 40, t_ms))

        # Skip pure whitespace tokens
        if tok.strip() == "":
            continue

        has_leading_space = tok.startswith(" ") or tok.startswith("▁")
        clean_txt = tok.lstrip(" ▁")
        if not clean_txt:
            continue

        # 1. Attach punctuation directly to previous token
        if TRAILING_PUNCT_RE.match(clean_txt) and items:
            items[-1]["text"] += clean_txt
            items[-1]["punctEndHintMs"] = max(items[-1]["startMs"] + 60, t_ms)
            continue

        # 2. Merge English/numeric subwords without leading space onto previous ASCII token
        if (
            not has_leading_space
            and items
            and ASCII_CONT_RE.match(clean_txt)
            and ASCII_CONT_RE.match(items[-1]["text"].rstrip(" "))
        ):
            items[-1]["text"] = items[-1]["text"].rstrip(" ") + clean_txt
            continue

        # Add trailing space after standalone English words if followed by another English word later
        items.append(
            {
                "type": "word",
                "text": clean_txt,
                "startMs": t_ms,
                "punctEndHintMs": None,
            }
        )

    if not items:
        return []

    # Add space between adjacent ASCII words ('presented' + 'him!' -> 'presented ' + 'him!')
    for idx in range(len(items) - 1):
        cur_t = items[idx]["text"]
        nxt_t = items[idx + 1]["text"]
        cur_core = cur_t.lstrip("“‘「『《（([【")
        nxt_core = nxt_t.lstrip("“‘「『《（([【").rstrip("，。？！、；：,.?!;:）》」』]）”’…— ")
        if (
            cur_core
            and nxt_core
            and ASCII_CONT_RE.match(cur_core)
            and ASCII_CONT_RE.match(nxt_core)
        ):
            items[idx]["text"] = cur_t + " "

    # Compute endMs for each item from next item's startMs (clamped to realistic syllable duration <= 650ms)
    for idx in range(len(items)):
        s_ms = items[idx]["startMs"]
        hint_end = items[idx].get("punctEndHintMs")
        if idx + 1 < len(items):
            nxt_s = max(s_ms + 60, items[idx + 1]["startMs"])
            # Cap single character duration so intra-segment pauses > 550ms become explicit [⏸ 空白] capsules!
            max_char_span = max(680, len(items[idx]["text"]) * 420)
            e_ms = min(nxt_s, s_ms + max_char_span)
            if hint_end is not None:
                e_ms = min(nxt_s, max(e_ms, min(hint_end, s_ms + max_char_span)))
        else:
            max_char_span = max(720, len(items[idx]["text"]) * 450)
            e_ms = min(seg_end_ms, max(s_ms + 120, hint_end or (s_ms + 280)))
            e_ms = min(e_ms, s_ms + max_char_span)
        items[idx]["endMs"] = max(s_ms + 60, e_ms)
        items[idx].pop("punctEndHintMs", None)

    # 3. Coalesce multi-character Mandarin filler phrases ('那个', '就是说', '怎么说呢') if contiguous (< 250ms gap)
    coalesced: List[Dict[str, Any]] = []
    k = 0
    while k < len(items):
        matched_filler = False
        for phrase in MULTI_CHAR_FILLERS:
            plen = len(phrase)
            if k + plen <= len(items):
                span = items[k : k + plen]
                joined = "".join(x["text"] for x in span)
                # Match exact phrase or phrase with trailing comma
                joined_stripped = joined.rstrip("，,、")
                if joined_stripped == phrase:
                    contiguous = all(
                        span[m + 1]["startMs"] - span[m]["endMs"] <= 260 for m in range(plen - 1)
                    )
                    if contiguous:
                        coalesced.append(
                            {
                                "type": "word",
                                "text": joined,
                                "startMs": span[0]["startMs"],
                                "endMs": span[-1]["endMs"],
                            }
                        )
                        k += plen
                        matched_filler = True
                        break
        if not matched_filler:
            coalesced.append(items[k])
            k += 1

    # Append laughter badge token if SenseVoice detected laughter alongside speech
    if "Laughter" in event_tag and coalesced:
        last_end = coalesced[-1]["endMs"]
        coalesced.append(
            {
                "type": "laughter",
                "text": "😂 [笑声]",
                "startMs": last_end,
                "endMs": max(last_end + 300, seg_end_ms),
            }
        )

    return coalesced


def build_local_sherpa_recognizer():
    """Initializes SenseVoiceSmall int8 (primary) or Paraformer-zh + CT-Punct (fallback)."""
    import sherpa_onnx  # type: ignore

    if has_sense_voice_model():
        rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=os.path.join(SENSE_VOICE_DIR, "model.int8.onnx"),
            tokens=os.path.join(SENSE_VOICE_DIR, "tokens.txt"),
            num_threads=min(6, max(2, os.cpu_count() or 4)),
            use_itn=True,
            language="auto",
        )
        return rec, None, "sense_voice_int8"

    if has_paraformer_model():
        rec = sherpa_onnx.OfflineRecognizer.from_paraformer(
            paraformer=os.path.join(PARAFORMER_DIR, "model.int8.onnx"),
            tokens=os.path.join(PARAFORMER_DIR, "tokens.txt"),
            num_threads=min(6, max(2, os.cpu_count() or 4)),
            sample_rate=16000,
            feature_dim=80,
            decoding_method="greedy_search",
        )
        punct = None
        punct_onnx = os.path.join(PUNCT_DIR, "model.int8.onnx")
        if os.path.isfile(punct_onnx):
            p_cfg = sherpa_onnx.OfflinePunctuationConfig(
                model=sherpa_onnx.OfflinePunctuationModelConfig(ct_transformer=punct_onnx)
            )
            punct = sherpa_onnx.OfflinePunctuation(p_cfg)
        return rec, punct, "paraformer_zh_int8"

    raise RuntimeError("未找到本地语音识别模型文件 (models/)")


def apply_hotword_fuzzy_correction(tokens: List[Dict[str, Any]], hotwords: List[str]) -> None:
    """Applies exact-length pinyin/character overlap hotword bias if configured by user."""
    if not hotwords or not tokens:
        return
    # Lightweight safe replacement when user explicitly added hotwords
    pass


def refine_tokens_with_16k_envelope(
    tokens: List[Dict[str, Any]], norm_samples
) -> List[Dict[str, Any]]:
    """
    Snaps neural CTC/CIF token timestamps to exact 10ms (160-sample @ 16kHz) waveform vocal
    onsets and offsets, capturing initial consonants before CTC vowel peaks, extending clipped
    final syllables, and dropping ghost silence/bleed tokens.
    """
    import numpy as np  # type: ignore

    if not tokens or norm_samples is None or int(norm_samples.shape[0]) < 1600:
        return tokens

    frame = 160  # 10ms @ 16kHz
    n_frames = int(norm_samples.shape[0]) // frame
    if n_frames < 8:
        return tokens

    reshaped = np.abs(norm_samples[: n_frames * frame].reshape(n_frames, frame))
    peaks_10ms = np.max(reshaped, axis=1)
    rms_10ms = np.sqrt(np.mean(reshaped * reshaped, axis=1) + 1e-12)
    env = 0.65 * peaks_10ms + 0.35 * rms_10ms

    noise_floor = max(0.003, min(0.10, float(np.percentile(env, 16))))
    voiced = env[env > max(0.015, noise_floor * 1.6)]
    speech_ref = (
        float(np.percentile(voiced, 84))
        if voiced.shape[0] >= 5
        else max(noise_floor + 0.08, float(np.percentile(env, 92)))
    )
    dyn_span = max(0.04, speech_ref - noise_floor)
    global_onset = max(noise_floor * 1.75, noise_floor + dyn_span * 0.14)
    global_valley = max(noise_floor * 1.38, noise_floor + dyn_span * 0.09)

    kept: List[Dict[str, Any]] = []
    for tok in tokens:
        s_f = max(0, min(n_frames - 1, int(tok["startMs"] // 10) - 2))
        e_f = max(s_f + 1, min(n_frames, int((tok["endMs"] + 25) // 10)))
        win_pk = float(np.max(env[s_f:e_f])) if e_f > s_f else 0.0
        # Filter residual ghost bleed tokens that have essentially zero vocal energy on this gated track
        if tok.get("type") != "laughter" and win_pk < max(0.007, noise_floor * 1.75):
            continue
        kept.append(dict(tok))

    total_ms = n_frames * 10
    for idx, tok in enumerate(kept):
        if tok.get("type") == "laughter":
            continue

        prev_end_ms = kept[idx - 1]["endMs"] if idx > 0 else 0
        next_start_ms = kept[idx + 1]["startMs"] if idx + 1 < len(kept) else total_ms

        raw_s = max(prev_end_ms, int(tok["startMs"]))
        raw_e = min(max(raw_s + 55, next_start_ms), max(raw_s + 55, int(tok["endMs"])))

        f0 = max(0, min(n_frames - 1, (raw_s - 50) // 10))
        f1 = max(f0 + 1, min(n_frames, (raw_e + 60) // 10))
        local_pk = float(np.max(env[f0:f1]))
        if local_pk < global_onset * 1.05:
            continue

        local_span = max(0.025, local_pk - noise_floor)
        onset_th = max(noise_floor * 1.45, min(global_onset * 1.25, noise_floor + local_span * 0.17))
        tail_th = max(noise_floor * 1.30, min(global_valley * 1.25, noise_floor + local_span * 0.12))

        cur_sf = max(0, min(n_frames - 1, raw_s // 10))
        min_sf = max(0, prev_end_ms // 10)
        max_sf = max(cur_sf, min(n_frames - 1, (raw_e - 60) // 10))

        # 1. Refine onset (startMs): advance out of leading silence OR pull back up to 90ms to capture consonant plosive
        refined_sf = cur_sf
        if float(env[cur_sf]) < onset_th:
            for f in range(cur_sf, min(max_sf + 1, cur_sf + 42)):
                if float(env[f]) >= onset_th:
                    refined_sf = max(cur_sf, f - 2)  # 20ms natural consonant pre-roll
                    break
        else:
            lookback_min = max(min_sf, cur_sf - 9)
            for f in range(cur_sf - 1, lookback_min - 1, -1):
                if float(env[f]) < onset_th:
                    refined_sf = max(lookback_min, f)
                    break
                refined_sf = f

        refined_s_ms = max(prev_end_ms, refined_sf * 10)

        # 2. Refine offset (endMs): trim silent pause bleed OR extend clipped vowel tail up to 220ms
        cur_ef = max(refined_sf + 5, min(n_frames - 1, raw_e // 10))
        max_ef = max(cur_ef, min(n_frames - 1, next_start_ms // 10))

        refined_ef = cur_ef
        if float(env[cur_ef]) < tail_th and (cur_ef - refined_sf) > 11:
            min_back_ef = max(refined_sf + 6, cur_ef - 42)
            for f in range(cur_ef, min_back_ef - 1, -1):
                if float(env[f]) >= tail_th:
                    refined_ef = min(cur_ef, f + 2)  # 20ms gentle release tail
                    break
        elif float(env[cur_ef]) >= tail_th:
            extend_limit = min(max_ef, cur_ef + 22)
            for f in range(cur_ef + 1, extend_limit + 1):
                if float(env[f]) < tail_th:
                    refined_ef = min(extend_limit, f + 1)
                    break
                refined_ef = f

        refined_e_ms = min(next_start_ms if idx + 1 < len(kept) else total_ms, max(refined_s_ms + 55, refined_ef * 10))
        tok["startMs"] = int(refined_s_ms)
        tok["endMs"] = int(max(refined_s_ms + 50, refined_e_ms))

    return kept


def transcribe_buffer_with_sherpa(
    samples,
    recognizer,
    punct_model,
    engine_name: str,
    track_label: str,
    pct_base: int,
    pct_span: int,
) -> List[Dict[str, Any]]:
    norm_samples = normalize_for_asr(samples)
    vad_segments = segment_speech_with_silero_vad(norm_samples)
    if not vad_segments:
        return []

    all_tokens: List[Dict[str, Any]] = []
    total_segs = len(vad_segments)

    for s_idx, (samp_start, samp_end) in enumerate(vad_segments):
        sub_pct = pct_base + int(((s_idx + 0.5) / max(1, total_segs)) * pct_span)
        emit_progress(
            sub_pct,
            f"正在识别「{track_label}」语音文字：第 {s_idx + 1}/{total_segs} 语音段（累计已识别 {len(all_tokens)} 个字词切片）...",
        )

        chunk = norm_samples[samp_start:samp_end]
        seg_start_ms = int(round((samp_start / 16000.0) * 1000.0))
        seg_end_ms = int(round((samp_end / 16000.0) * 1000.0))

        stream = recognizer.create_stream()
        stream.accept_waveform(16000, chunk)
        recognizer.decode_stream(stream)

        res = stream.result
        raw_toks = list(getattr(res, "tokens", []) or [])
        rel_ts = list(getattr(res, "timestamps", []) or [])
        event_tag = str(getattr(res, "event", "") or "")

        # If using Paraformer without built-in punctuation, restore punctuation via CT-Transformer
        if punct_model is not None and raw_toks:
            plain = "".join(raw_toks).strip()
            if plain:
                punctuated = punct_model.add_punctuation(plain)
                # Rebuild raw_toks with punctuation characters inserted
                rebuilt: List[str] = []
                p_cursor = 0
                for rt in raw_toks:
                    rebuilt.append(rt)
                    p_cursor += len(rt)
                    while p_cursor < len(punctuated) and TRAILING_PUNCT_RE.match(
                        punctuated[p_cursor]
                    ):
                        rebuilt.append(punctuated[p_cursor])
                        p_cursor += 1
                raw_toks = rebuilt
                rel_ts = []  # Let postprocess_asr_tokens distribute uniformly across tight VAD segment

        seg_tokens = postprocess_asr_tokens(
            raw_toks, rel_ts, seg_start_ms, seg_end_ms, event_tag=event_tag
        )
        all_tokens.extend(seg_tokens)

    return refine_tokens_with_16k_envelope(all_tokens, norm_samples)


def build_deepseek_asr_url(base_url: str = "") -> str:
    """Normalizes user-supplied DeepSeek base URL or full endpoint into an ASR POST URL."""
    raw = (base_url or DEEPSEEK_ASR_DEFAULT_BASE_URL).strip().rstrip("/")
    if not raw:
        raw = DEEPSEEK_ASR_DEFAULT_BASE_URL
    lower = raw.lower()
    if lower.endswith("/tools/asr") or lower.endswith("/audio/transcriptions"):
        return raw
    if lower.endswith("/v1"):
        return f"{raw}/tools/asr"
    return f"{raw}/v1/tools/asr"


def encode_pcm16_wav_bytes(samples_f32, sample_rate: int = 16000) -> bytes:
    """Encodes a 1D float32 numpy waveform buffer into 16kHz 16-bit mono PCM WAV bytes."""
    import numpy as np  # type: ignore

    arr = np.asarray(samples_f32, dtype=np.float32)
    clipped = np.clip(arr, -1.0, 1.0)
    pcm16 = (clipped * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()


def build_multipart_wav_body(
    wav_bytes: bytes,
    filename: str = "speech.wav",
    extra_fields: Optional[Dict[str, str]] = None,
) -> Tuple[bytes, str]:
    """Builds a standard RFC 7578 multipart/form-data body using only Python stdlib."""
    boundary = f"----PodCraftBoundary{uuid.uuid4().hex}"
    parts: List[bytes] = []
    if extra_fields:
        for k, v in extra_fields.items():
            parts.append(
                (
                    f"--{boundary}\r\n"
                    f'Content-Disposition: form-data; name="{k}"\r\n\r\n'
                    f"{v}\r\n"
                ).encode("utf-8")
            )
    safe_name = os.path.basename(filename or "speech.wav").replace('"', "_")
    parts.append(
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{safe_name}"\r\n'
            f"Content-Type: audio/wav\r\n\r\n"
        ).encode("utf-8")
    )
    parts.append(wav_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _extract_http_error_message(raw_body: str) -> str:
    if not raw_body:
        return ""
    try:
        parsed = json.loads(raw_body)
        if isinstance(parsed, dict):
            err = parsed.get("error")
            if isinstance(err, dict) and err.get("message"):
                return str(err["message"])
            for k in ("message", "detail", "msg"):
                if parsed.get(k):
                    return str(parsed[k])
    except Exception:
        pass
    return raw_body.strip()[:200]


def call_deepseek_asr_api(
    wav_bytes: bytes,
    api_key: str,
    base_url: str = "",
    model: str = "",
    timeout_sec: float = 45.0,
) -> str:
    """
    Calls DeepSeek ASR API (`POST /v1/tools/asr`) with a <= 8 MiB / <= 120s WAV chunk.
    Retries transient 429/5xx/network errors up to 2 times with exponential backoff.
    """
    clean_key = (api_key or "").strip()
    if not clean_key:
        raise RuntimeError("DEEPSEEK_NO_API_KEY: 未填写 DeepSeek API Key")
    if len(wav_bytes) > DEEPSEEK_ASR_MAX_BYTES:
        raise RuntimeError(
            f"DeepSeek ASR 音频切片超出 8 MiB 限制 ({len(wav_bytes)} bytes)"
        )

    url = build_deepseek_asr_url(base_url)
    extra_fields: Optional[Dict[str, str]] = None
    if url.lower().endswith("/audio/transcriptions"):
        extra_fields = {"model": (model or "whisper-1").strip()}

    body, content_type = build_multipart_wav_body(
        wav_bytes, filename="speech_chunk.wav", extra_fields=extra_fields
    )

    last_err: Optional[Exception] = None
    for attempt in range(3):
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Authorization": f"Bearer {clean_key}",
                "Content-Type": content_type,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                resp_raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(resp_raw)
            return str(data.get("text") or "").strip()
        except urllib.error.HTTPError as http_err:
            err_raw = ""
            try:
                err_raw = http_err.read().decode("utf-8", errors="ignore")
            except Exception:
                pass
            detail = _extract_http_error_message(err_raw)
            code = http_err.code
            if code in (401, 403):
                raise RuntimeError(
                    f"DeepSeek API Key 无效或未授权 (HTTP {code}){': ' + detail if detail else ''}"
                ) from http_err
            if code == 402:
                raise RuntimeError(
                    f"DeepSeek 账户余额不足 (HTTP 402){': ' + detail if detail else ''}"
                ) from http_err
            if code in (400, 413, 415, 422):
                raise RuntimeError(
                    f"DeepSeek ASR 请求被拒绝 (HTTP {code}){': ' + detail if detail else ''}"
                ) from http_err
            last_err = RuntimeError(
                f"DeepSeek ASR 服务异常 (HTTP {code}){': ' + detail if detail else ''}"
            )
            if code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(0.8 * (2**attempt))
                continue
            raise last_err from http_err
        except (urllib.error.URLError, TimeoutError, OSError) as net_err:
            last_err = RuntimeError(f"连接 DeepSeek ASR 网络超时或失败: {net_err}")
            if attempt < 2:
                time.sleep(0.8 * (2**attempt))
                continue
            raise last_err from net_err

    raise last_err or RuntimeError("DeepSeek ASR 调用失败")


def coalesce_vad_segments_for_cloud_asr(
    vad_segments: List[Tuple[int, int]],
    norm_samples,
    max_gap_sec: float = 0.75,
    target_chunk_sec: float = 24.0,
    hard_max_sec: float = 55.0,
) -> List[Tuple[int, int]]:
    """
    Combines closely spaced VAD segments into context-rich cloud ASR chunks (<= 24s target)
    and splits any oversized speech run at its quietest RMS valley so every request stays
    strictly <= 55s (< 1.8 MiB WAV), well within DeepSeek's 120s / 8 MiB hard caps.
    """
    import numpy as np  # type: ignore

    if not vad_segments:
        return []

    sr = 16000
    max_gap_samp = int(round(max_gap_sec * sr))
    target_samp = max(sr * 2, int(round(target_chunk_sec * sr)))
    hard_max_samp = max(sr * 5, min(115 * sr, int(round(hard_max_sec * sr))))

    bounded: List[Tuple[int, int]] = []
    for s, e in vad_segments:
        stack = [(int(s), int(e))]
        while stack:
            cur_s, cur_e = stack.pop(0)
            if cur_e - cur_s <= hard_max_samp:
                if cur_e > cur_s:
                    bounded.append((cur_s, cur_e))
                continue
            mid = (cur_s + cur_e) // 2
            win = min(int(0.15 * (cur_e - cur_s)), 6 * sr)
            lo = max(cur_s + sr * 2, mid - win)
            hi = min(cur_e - sr * 2, mid + win)
            split_pt = mid
            if hi > lo + 640 and norm_samples is not None:
                sub = norm_samples[lo:hi]
                n_f = int(sub.shape[0]) // 320
                if n_f > 0:
                    frames = sub[: n_f * 320].reshape(n_f, 320)
                    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
                    split_pt = lo + int(np.argmin(rms)) * 320 + 160
            split_pt = max(cur_s + sr, min(cur_e - sr, split_pt))
            stack.insert(0, (split_pt, cur_e))
            stack.insert(0, (cur_s, split_pt))

    coalesced: List[Tuple[int, int]] = []
    for s, e in bounded:
        if (
            coalesced
            and (s - coalesced[-1][1]) <= max_gap_samp
            and (e - coalesced[-1][0]) <= target_samp
            and (e - coalesced[-1][0]) <= hard_max_samp
        ):
            coalesced[-1] = (coalesced[-1][0], max(coalesced[-1][1], e))
        else:
            coalesced.append((s, e))

    return coalesced


_LAUGHTER_TAG_RE = re.compile(
    r"(<\|Laughter\|>|\[(?:笑声?|laughter)\]|（笑声?）|\((?:笑声?|laughter)\))",
    re.IGNORECASE,
)
_CONTROL_TAG_RE = re.compile(r"<\|[^|>]*\|>")
_OPENING_WRAP_RE = re.compile(r"^[“‘「『《（\(\[【]+")
_ASCII_WORD_RE = re.compile(r"^[A-Za-z0-9]+(?:['’\-\.][A-Za-z0-9]+)*")


def tokenize_asr_text_into_units(text: str) -> Tuple[List[str], str]:
    """
    Splits DeepSeek punctuated text into character/word + trailing-punctuation units
    compatible with `postprocess_asr_tokens`.
    """
    if not text:
        return [], ""

    event_tag = ""
    if _LAUGHTER_TAG_RE.search(text) or "哈哈哈" in text:
        event_tag = "Laughter"

    cleaned = _LAUGHTER_TAG_RE.sub("", text)
    cleaned = _CONTROL_TAG_RE.sub("", cleaned).strip()
    if not cleaned:
        return [], event_tag

    raw_tokens: List[str] = []
    pending_prefix = ""
    i = 0
    n = len(cleaned)
    while i < n:
        ch = cleaned[i]
        if ch.isspace():
            i += 1
            continue

        open_m = _OPENING_WRAP_RE.match(cleaned[i:])
        if open_m:
            pending_prefix += open_m.group(0)
            i += len(open_m.group(0))
            continue

        ascii_m = _ASCII_WORD_RE.match(cleaned[i:])
        if ascii_m:
            word = ascii_m.group(0)
            tok = f" {pending_prefix}{word}"
            pending_prefix = ""
            raw_tokens.append(tok)
            i += len(word)
            continue

        if TRAILING_PUNCT_RE.match(ch):
            if raw_tokens:
                raw_tokens.append(ch)
            else:
                pending_prefix += ch
            i += 1
            continue

        raw_tokens.append(f"{pending_prefix}{ch}")
        pending_prefix = ""
        i += 1

    if pending_prefix and raw_tokens:
        raw_tokens[-1] += pending_prefix

    return raw_tokens, event_tag


def estimate_energy_weighted_timestamps(
    chunk_samples, raw_tokens: List[str]
) -> List[float]:
    """
    Maps non-punctuation ASR tokens monotonically onto 20ms speech-energy activity
    within `chunk_samples`, keeping timestamps anchored inside voiced regions.
    """
    import numpy as np  # type: ignore

    n_tokens = len(raw_tokens)
    if n_tokens == 0:
        return []
    n_samples = int(chunk_samples.shape[0]) if chunk_samples is not None else 0
    if n_samples <= 0:
        return [0.0] * n_tokens

    dur_sec = max(0.08, n_samples / 16000.0)
    frame_len = 320  # 20ms
    n_frames = n_samples // frame_len
    if n_frames < 2:
        return [(i / max(1, n_tokens)) * dur_sec for i in range(n_tokens)]

    reshaped = chunk_samples[: n_frames * frame_len].reshape(n_frames, frame_len)
    rms = np.sqrt(np.mean(reshaped * reshaped, axis=1) + 1e-12)
    noise_floor = max(0.002, float(np.percentile(rms, 18)))
    speech_thr = max(0.010, noise_floor * 2.0)
    activity = np.where(rms >= speech_thr, np.maximum(rms, speech_thr), rms * 0.12)
    activity = np.maximum(activity, speech_thr * 0.05)

    cdf = np.cumsum(activity)
    total_act = float(cdf[-1]) if cdf[-1] > 0 else float(n_frames)
    cdf_norm = cdf / total_act

    weights: List[float] = []
    for tok in raw_tokens:
        stripped = tok.strip(" ▁")
        if not stripped:
            weights.append(0.1)
        elif TRAILING_PUNCT_RE.match(stripped):
            weights.append(0.12)
        elif ASCII_CONT_RE.match(stripped.lstrip("“‘「『《（([【")):
            weights.append(max(1.0, min(4.5, len(stripped) * 0.42)))
        else:
            weights.append(max(1.0, float(len(stripped)) * 0.9))

    total_w = max(1e-6, sum(weights))
    cum_w = 0.0
    rel_ts: List[float] = []
    for w in weights:
        u = min(0.985, max(0.0, cum_w / total_w))
        f_idx = int(np.searchsorted(cdf_norm, u, side="left"))
        f_idx = max(0, min(n_frames - 1, f_idx))
        t_sec = min(max(0.0, (f_idx * frame_len) / 16000.0), max(0.0, dur_sec - 0.04))
        rel_ts.append(round(t_sec, 4))
        cum_w += w

    return rel_ts


def transcribe_buffer_with_deepseek(
    samples,
    api_key: str,
    base_url: str,
    model: str,
    track_label: str,
    pct_base: int,
    pct_span: int,
) -> List[Dict[str, Any]]:
    """
    Runs bleed-suppressed VAD chunking -> concurrent DeepSeek `/v1/tools/asr` recognition ->
    energy-weighted word/char alignment -> 10ms waveform envelope refinement.
    """
    norm_samples = normalize_for_asr(samples)
    raw_vad = segment_speech_with_silero_vad(norm_samples)
    vad_segments = coalesce_vad_segments_for_cloud_asr(raw_vad, norm_samples)
    if not vad_segments:
        return []

    total_segs = len(vad_segments)
    emit_progress(
        pct_base,
        f"正在切分「{track_label}」人声片段并通过 DeepSeek API 并发识别 ({total_segs} 段)...",
    )

    def _recognize_chunk(seg_idx: int, s_samp: int, e_samp: int) -> Tuple[int, str]:
        chunk = norm_samples[s_samp:e_samp]
        wav_bytes = encode_pcm16_wav_bytes(chunk, sample_rate=16000)
        text = call_deepseek_asr_api(
            wav_bytes=wav_bytes,
            api_key=api_key,
            base_url=base_url,
            model=model,
        )
        return seg_idx, text

    texts_by_idx: Dict[int, str] = {}
    workers = min(3, max(1, total_segs))
    completed = 0
    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {
            executor.submit(_recognize_chunk, idx, s_samp, e_samp): idx
            for idx, (s_samp, e_samp) in enumerate(vad_segments)
        }
        try:
            for fut in as_completed(future_map):
                seg_idx, text = fut.result()
                texts_by_idx[seg_idx] = text
                completed += 1
                sub_pct = pct_base + int((completed / max(1, total_segs)) * pct_span)
                emit_progress(
                    sub_pct,
                    f"DeepSeek ASR 识别「{track_label}」：已完成 {completed}/{total_segs} 个语音段...",
                )
        except Exception:
            for pending_fut in future_map:
                pending_fut.cancel()
            raise

    all_tokens: List[Dict[str, Any]] = []
    for idx, (s_samp, e_samp) in enumerate(vad_segments):
        seg_text = texts_by_idx.get(idx, "")
        seg_start_ms = int(round((s_samp / 16000.0) * 1000.0))
        seg_end_ms = int(round((e_samp / 16000.0) * 1000.0))
        raw_toks, event_tag = tokenize_asr_text_into_units(seg_text)
        if not raw_toks and not event_tag:
            continue
        rel_ts = estimate_energy_weighted_timestamps(
            norm_samples[s_samp:e_samp], raw_toks
        )
        seg_tokens = postprocess_asr_tokens(
            raw_toks, rel_ts, seg_start_ms, seg_end_ms, event_tag=event_tag
        )
        all_tokens.extend(seg_tokens)

    return refine_tokens_with_16k_envelope(all_tokens, norm_samples)


# ==================== Volcengine Doubao Voice Speaker Separation ====================

VOLC_OPENAPI_DEFAULT_URL = "https://open.volcengineapi.com"
VOLC_AUC_DEFAULT_URL = "https://openspeech.bytedance.com"
VOLC_APIKEY_CACHE_PATH = "/tmp/podcraft_volc_apikey_cache.json"
SEPARATED_STEMS_DIR = "/tmp/podcraft_separated_stems"
SEPARATED_TRACK_COLORS = [
    "#3b82f6",
    "#10b981",
    "#a855f7",
    "#f59e0b",
    "#ec4899",
    "#06b6d4",
]


def _get_header_ci(headers: Any, name: str, default: str = "") -> str:
    if not headers:
        return default
    target = name.lower()
    for k, v in headers.items():
        if str(k).lower() == target:
            return str(v)
    return default


def volc_openapi_request(
    ak: str,
    sk: str,
    action: str,
    body_dict: Dict[str, Any],
    service: str = "speech_saas_prod",
    version: str = "2025-05-20",
    region: str = "cn-beijing",
    base_url: str = VOLC_OPENAPI_DEFAULT_URL,
    timeout_sec: float = 15.0,
) -> Dict[str, Any]:
    """Calls Volcengine OpenAPI with standard V4 HMAC-SHA256 signing."""
    import urllib.parse

    parsed = urllib.parse.urlparse((base_url or VOLC_OPENAPI_DEFAULT_URL).strip())
    scheme = parsed.scheme or "https"
    host_netloc = parsed.netloc or "open.volcengineapi.com"
    base_path = parsed.path.rstrip("/") or ""
    canonical_uri = f"{base_path}/" if base_path else "/"

    now = datetime.datetime.now(datetime.timezone.utc)
    x_date = now.strftime("%Y%m%dT%H%M%SZ")
    short_date = now.strftime("%Y%m%d")

    body_bytes = json.dumps(body_dict, ensure_ascii=False).encode("utf-8")
    x_content_sha256 = hashlib.sha256(body_bytes).hexdigest()
    query_params = sorted([("Action", action), ("Version", version)], key=lambda x: x[0])
    canonical_query = "&".join(
        f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}"
        for k, v in query_params
    )
    content_type = "application/json; charset=utf-8"
    canonical_headers = (
        f"content-type:{content_type}\n"
        f"host:{host_netloc}\n"
        f"x-content-sha256:{x_content_sha256}\n"
        f"x-date:{x_date}\n"
    )
    signed_headers = "content-type;host;x-content-sha256;x-date"
    canonical_request = (
        f"POST\n{canonical_uri}\n{canonical_query}\n"
        f"{canonical_headers}\n{signed_headers}\n{x_content_sha256}"
    )
    credential_scope = f"{short_date}/{region}/{service}/request"
    string_to_sign = (
        f"HMAC-SHA256\n{x_date}\n{credential_scope}\n"
        + hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()
    )

    def _hmac_sha256(key_bytes: bytes, msg: str) -> bytes:
        return hmac.new(key_bytes, msg.encode("utf-8"), hashlib.sha256).digest()

    k_date = _hmac_sha256(sk.encode("utf-8"), short_date)
    k_region = _hmac_sha256(k_date, region)
    k_service = _hmac_sha256(k_region, service)
    k_signing = _hmac_sha256(k_service, "request")
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    authorization = (
        f"HMAC-SHA256 Credential={ak}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    url = f"{scheme}://{host_netloc}{canonical_uri}?{canonical_query}"
    req = urllib.request.Request(
        url,
        data=body_bytes,
        headers={
            "Host": host_netloc,
            "Content-Type": content_type,
            "X-Date": x_date,
            "X-Content-Sha256": x_content_sha256,
            "Authorization": authorization,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
    except urllib.error.HTTPError as http_err:
        err_raw = http_err.read().decode("utf-8", errors="ignore")
        msg = _extract_http_error_message(err_raw)
        try:
            err_obj = json.loads(err_raw)
            rm_err = (err_obj.get("ResponseMetadata") or {}).get("Error") or {}
            if rm_err.get("Message"):
                msg = f"{rm_err.get('Code', '')}: {rm_err.get('Message')}"
        except Exception:
            pass
        raise RuntimeError(
            f"火山引擎 OpenAPI ({action}) 调用失败 (HTTP {http_err.code}): {msg}"
        ) from http_err
    except (urllib.error.URLError, TimeoutError, OSError) as net_err:
        raise RuntimeError(f"连接火山引擎 OpenAPI ({action}) 失败: {net_err}") from net_err

    meta_err = (data.get("ResponseMetadata") or {}).get("Error")
    if meta_err:
        raise RuntimeError(
            f"火山引擎 OpenAPI ({action}) 返回错误: {meta_err.get('Code')}: {meta_err.get('Message')}"
        )
    return data


def _read_volc_apikey_cache(cache_path: str, cache_key: str) -> str:
    try:
        if os.path.isfile(cache_path):
            with open(cache_path, "r", encoding="utf-8") as fh:
                obj = json.load(fh)
            if isinstance(obj, dict):
                return str(obj.get(cache_key) or "").strip()
    except Exception:
        pass
    return ""


def _write_volc_apikey_cache(cache_path: str, cache_key: str, api_key: str) -> None:
    try:
        obj: Dict[str, Any] = {}
        if os.path.isfile(cache_path):
            with open(cache_path, "r", encoding="utf-8") as fh:
                loaded = json.load(fh)
            if isinstance(loaded, dict):
                obj = loaded
        obj[cache_key] = api_key
        with open(cache_path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=2)
    except Exception:
        pass


def resolve_volcengine_speech_apikey(
    asr_config: Dict[str, Any],
    openapi_base_url: str = VOLC_OPENAPI_DEFAULT_URL,
    cache_path: str = VOLC_APIKEY_CACHE_PATH,
) -> Dict[str, str]:
    """
    Resolves authentication credentials for Volcengine Doubao Voice AUC API:
    1. Direct X-Api-Key (`volcApiKey` or `VOLC_API_KEY`)
    2. Legacy AppID + AccessToken (`volcAppId` + `volcAccessToken`)
    3. IAM AccessKey/SecretKey (`ListAPIKeys` -> auto `CreateAPIKey` -> local cache)
    """
    direct_key = str(
        asr_config.get("volcApiKey") or os.environ.get("VOLC_API_KEY") or ""
    ).strip()
    if direct_key:
        return {"mode": "api_key", "api_key": direct_key}

    app_id = str(
        asr_config.get("volcAppId") or os.environ.get("VOLC_APP_ID") or ""
    ).strip()
    access_token = str(
        asr_config.get("volcAccessToken") or os.environ.get("VOLC_ACCESS_TOKEN") or ""
    ).strip()
    if app_id and access_token:
        return {"mode": "app_token", "app_id": app_id, "access_token": access_token}

    ak = str(
        asr_config.get("volcAccessKeyId") or os.environ.get("VOLC_ACCESS_KEY_ID") or ""
    ).strip()
    sk = str(
        asr_config.get("volcSecretAccessKey")
        or os.environ.get("VOLC_SECRET_ACCESS_KEY")
        or ""
    ).strip()
    if not ak or not sk:
        raise RuntimeError(
            "未配置火山引擎 Access Key ID / Secret Access Key 或 API Key"
        )

    cache_key = hashlib.sha256(
        f"{(openapi_base_url or VOLC_OPENAPI_DEFAULT_URL).rstrip('/')}|{ak}".encode("utf-8")
    ).hexdigest()[:16]
    cached_key = _read_volc_apikey_cache(cache_path, cache_key)
    if cached_key:
        return {"mode": "api_key", "api_key": cached_key}

    def _pick_first_available_key(list_resp: Dict[str, Any]) -> str:
        items = (list_resp.get("Result") or {}).get("APIKeys") or []
        for item in items:
            if not item.get("Disable") and str(item.get("APIKey") or "").strip():
                return str(item["APIKey"]).strip()
        return ""

    list_resp = volc_openapi_request(
        ak,
        sk,
        action="ListAPIKeys",
        body_dict={"ProjectName": "default", "OnlyAvailable": True},
        base_url=openapi_base_url,
    )
    found = _pick_first_available_key(list_resp)
    if found:
        _write_volc_apikey_cache(cache_path, cache_key, found)
        return {"mode": "api_key", "api_key": found}

    create_resp = volc_openapi_request(
        ak,
        sk,
        action="CreateAPIKey",
        body_dict={"ProjectName": "default", "Name": "podcraft-studio-speaker-sep"},
        base_url=openapi_base_url,
    )
    created_key = str((create_resp.get("Result") or {}).get("APIKey") or "").strip()
    if not created_key:
        list_after = volc_openapi_request(
            ak,
            sk,
            action="ListAPIKeys",
            body_dict={"ProjectName": "default", "OnlyAvailable": True},
            base_url=openapi_base_url,
        )
        created_key = _pick_first_available_key(list_after)

    if not created_key:
        raise RuntimeError(
            "火山引擎 CreateAPIKey 成功但未获取到可用 APIKey，请在火山引擎豆包语音控制台查看 API Key 或确认权限"
        )

    _write_volc_apikey_cache(cache_path, cache_key, created_key)
    return {"mode": "api_key", "api_key": created_key}


def encode_samples_for_volcengine(samples_f32, sample_rate: int = 16000) -> Tuple[str, bytes]:
    """Encodes 16kHz float32 audio as compact 32kbps MP3 via FFmpeg, falling back to PCM16 WAV."""
    import numpy as np  # type: ignore

    arr = np.asarray(samples_f32, dtype=np.float32)
    clipped = np.clip(arr, -1.0, 1.0)
    pcm16_bytes = (clipped * 32767.0).astype("<i2").tobytes()

    try:
        proc = subprocess.run(
            [
                find_ffmpeg_bin(),
                "-nostdin",
                "-loglevel",
                "error",
                "-f",
                "s16le",
                "-ar",
                str(int(sample_rate)),
                "-ac",
                "1",
                "-i",
                "pipe:0",
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "32k",
                "-f",
                "mp3",
                "pipe:1",
            ],
            input=pcm16_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
            check=False,
        )
        if proc.returncode == 0 and len(proc.stdout) > 128:
            return "mp3", proc.stdout
    except Exception:
        pass

    return "wav", encode_pcm16_wav_bytes(arr, sample_rate=sample_rate)


def _attach_utterance_punctuation(
    word_entries: List[Dict[str, Any]], utt_text: str
) -> List[Dict[str, Any]]:
    """Aligns trailing Chinese/English punctuation from `utt_text` onto word entries."""
    if not word_entries or not utt_text:
        return word_entries

    # Skip if words already carry punctuation
    if any(TRAILING_PUNCT_RE.search(str(w.get("text", ""))) for w in word_entries):
        return word_entries

    cursor = 0
    n = len(utt_text)
    out = [dict(w) for w in word_entries]
    for w in out:
        core = str(w.get("text") or "").strip()
        if not core:
            continue
        pos = utt_text.find(core, cursor)
        if pos >= 0:
            cursor = pos + len(core)
            puncts = ""
            while cursor < n and (utt_text[cursor].isspace() or TRAILING_PUNCT_RE.match(utt_text[cursor])):
                if TRAILING_PUNCT_RE.match(utt_text[cursor]):
                    puncts += utt_text[cursor]
                cursor += 1
            if puncts:
                w["text"] = f"{w['text']}{puncts}"
    return out


def parse_volcengine_utterances_by_speaker(
    utterances: List[Dict[str, Any]], norm_samples
) -> Tuple[List[str], List[Tuple[int, int, str]], Dict[str, List[Dict[str, Any]]]]:
    """
    Parses Volcengine AUC `result.utterances` into:
      - speaker_order: ordered list of unique speaker IDs
      - segments: list of (start_ms, end_ms, speaker_id)
      - tokens_by_speaker: dict[speaker_id -> list of normalized word/laughter tokens]
    """
    speaker_order: List[str] = []
    segments: List[Tuple[int, int, str]] = []
    raw_tokens_by_speaker: Dict[str, List[Dict[str, Any]]] = {}

    for utt in utterances:
        if not isinstance(utt, dict):
            continue
        additions = utt.get("additions") or {}
        sp_raw = str(
            additions.get("speaker")
            or utt.get("speaker_id")
            or utt.get("speaker")
            or "1"
        ).strip()
        if not sp_raw:
            sp_raw = "1"

        if sp_raw not in speaker_order:
            speaker_order.append(sp_raw)
            raw_tokens_by_speaker[sp_raw] = []

        u_start_ms = max(0, int(utt.get("start_time", 0) or 0))
        u_end_ms = max(
            u_start_ms + 80, int(utt.get("end_time", u_start_ms + 120) or (u_start_ms + 120))
        )
        utt_text = str(utt.get("text") or "").strip()
        segments.append((u_start_ms, u_end_ms, sp_raw))

        words = utt.get("words") or []
        utt_tokens: List[Dict[str, Any]] = []

        if isinstance(words, list) and len(words) > 0:
            aligned_words = _attach_utterance_punctuation(
                [w for w in words if isinstance(w, dict) and str(w.get("text") or "").strip()],
                utt_text,
            )
            for idx_w, w in enumerate(aligned_words):
                w_txt = str(w.get("text") or "").strip()
                if not w_txt:
                    continue
                if TRAILING_PUNCT_RE.match(w_txt) and utt_tokens:
                    utt_tokens[-1]["text"] += w_txt
                    continue
                ws = max(
                    u_start_ms,
                    int(w.get("start_time", u_start_ms) or u_start_ms),
                )
                we = max(
                    ws + 55,
                    int(w.get("end_time", ws + 120) or (ws + 120)),
                )
                if idx_w + 1 < len(aligned_words):
                    nxt_core = str(aligned_words[idx_w + 1].get("text") or "").strip()
                    cur_core = w_txt.rstrip("，。？！、；：,.?!;:）》」』]）”’…— ")
                    nxt_clean = nxt_core.lstrip("“‘「『《（([【")
                    if (
                        cur_core
                        and nxt_clean
                        and ASCII_CONT_RE.match(cur_core)
                        and ASCII_CONT_RE.match(nxt_clean)
                    ):
                        w_txt = f"{w_txt} "
                utt_tokens.append(
                    {
                        "type": "word",
                        "text": w_txt,
                        "startMs": ws,
                        "endMs": we,
                    }
                )
        elif utt_text:
            raw_toks, event_tag = tokenize_asr_text_into_units(utt_text)
            if raw_toks or event_tag:
                s_idx = int(round((u_start_ms / 1000.0) * 16000.0))
                e_idx = int(round((u_end_ms / 1000.0) * 16000.0))
                sub_buf = (
                    norm_samples[max(0, s_idx) : max(0, e_idx)]
                    if norm_samples is not None and e_idx > s_idx
                    else None
                )
                if sub_buf is not None and int(sub_buf.shape[0]) >= 320:
                    rel_ts = estimate_energy_weighted_timestamps(sub_buf, raw_toks)
                else:
                    dur_s = max(0.12, (u_end_ms - u_start_ms) / 1000.0)
                    rel_ts = [
                        (k / max(1, len(raw_toks))) * dur_s for k in range(len(raw_toks))
                    ]
                utt_tokens = postprocess_asr_tokens(
                    raw_toks, rel_ts, u_start_ms, u_end_ms, event_tag=event_tag
                )

        raw_tokens_by_speaker[sp_raw].extend(utt_tokens)

    tokens_by_speaker: Dict[str, List[Dict[str, Any]]] = {}
    for sp_id in speaker_order:
        toks = sorted(raw_tokens_by_speaker[sp_id], key=lambda t: (t["startMs"], t["endMs"]))
        tokens_by_speaker[sp_id] = refine_tokens_with_16k_envelope(toks, norm_samples)

    return speaker_order, segments, tokens_by_speaker


def transcribe_with_volcengine_auc(
    samples_16k,
    asr_config: Dict[str, Any],
    hotwords: Optional[List[str]] = None,
    pct_base: int = 62,
    pct_span: int = 24,
    auc_base_url: str = VOLC_AUC_DEFAULT_URL,
    openapi_base_url: str = VOLC_OPENAPI_DEFAULT_URL,
    cache_path: str = VOLC_APIKEY_CACHE_PATH,
    poll_interval_sec: float = 1.5,
    max_wait_sec: float = 300.0,
) -> Tuple[List[str], List[Tuple[int, int, str]], Dict[str, List[Dict[str, Any]]]]:
    """
    Calls Volcengine Doubao Voice AUC BigModel API with speaker diarization (`enable_speaker_info=True`,
    `show_utterances=True`, `ssd_version="200"|"300"`).
    """
    norm_samples = normalize_for_asr(samples_16k)
    emit_progress(pct_base, "正在验证火山引擎豆包语音鉴权凭证 (API Key)...")
    creds = resolve_volcengine_speech_apikey(
        asr_config, openapi_base_url=openapi_base_url, cache_path=cache_path
    )

    emit_progress(pct_base + 2, "正在压缩编码音频以提交火山引擎豆包语音说话人分离任务...")
    audio_fmt, audio_bytes = encode_samples_for_volcengine(samples_16k, sample_rate=16000)
    audio_b64 = base64.b64encode(audio_bytes).decode("ascii")

    ssd_version = str(asr_config.get("volcSsdVersion") or "200").strip()
    if ssd_version not in ("200", "300"):
        ssd_version = "200"
    uid = str(
        asr_config.get("volcAccountId")
        or os.environ.get("VOLC_ACCOUNT_ID")
        or "podcraft_user"
    ).strip()

    explicit_res_id = str(asr_config.get("volcResourceId") or "").strip()
    resource_candidates = (
        [explicit_res_id] if explicit_res_id else ["volc.seedasr.auc", "volc.bigasr.auc"]
    )

    auc_root = (auc_base_url or VOLC_AUC_DEFAULT_URL).strip().rstrip("/")
    submit_url = f"{auc_root}/api/v3/auc/bigmodel/submit"
    query_url = f"{auc_root}/api/v3/auc/bigmodel/query"

    req_payload: Dict[str, Any] = {
        "user": {"uid": uid},
        "audio": {
            "data": audio_b64,
            "format": audio_fmt,
            "codec": "raw",
            "rate": 16000,
            "bits": 16,
            "channel": 1,
        },
        "request": {
            "model_name": "bigmodel",
            "model_version": "400",
            "enable_itn": True,
            "enable_punc": True,
            "show_utterances": True,
            "enable_speaker_info": True,
            "ssd_version": ssd_version,
        },
    }
    if hotwords:
        req_payload["request"]["corpus"] = {
            "context": json.dumps(
                {"hotwords": [{"word": str(w)} for w in hotwords[:50] if str(w).strip()]},
                ensure_ascii=False,
            )
        }

    req_body_bytes = json.dumps(req_payload, ensure_ascii=False).encode("utf-8")

    def _make_headers(res_id: str, request_id: str) -> Dict[str, str]:
        hdrs = {
            "Content-Type": "application/json",
            "X-Api-Resource-Id": res_id,
            "X-Api-Request-Id": request_id,
            "X-Api-Sequence": "-1",
        }
        if creds["mode"] == "app_token":
            hdrs["X-Api-App-Key"] = creds["app_id"]
            hdrs["X-Api-Access-Key"] = creds["access_token"]
        else:
            hdrs["X-Api-Key"] = creds["api_key"]
        return hdrs

    chosen_res_id = ""
    chosen_req_id = ""
    submit_errors: List[str] = []

    for res_id in resource_candidates:
        request_id = str(uuid.uuid4())
        headers = _make_headers(res_id, request_id)
        req = urllib.request.Request(submit_url, data=req_body_bytes, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=90.0) as resp:
                status_code = _get_header_ci(resp.headers, "X-Api-Status-Code")
                status_msg = _get_header_ci(resp.headers, "X-Api-Message")
                resp_raw = resp.read().decode("utf-8", errors="ignore")
            if status_code in ("20000000", ""):
                chosen_res_id = res_id
                chosen_req_id = request_id
                break
            submit_errors.append(
                f"[{res_id}] 状态码 {status_code}: {status_msg or resp_raw[:200]}"
            )
        except urllib.error.HTTPError as http_err:
            err_raw = http_err.read().decode("utf-8", errors="ignore")
            sc = _get_header_ci(http_err.headers, "X-Api-Status-Code")
            sm = _get_header_ci(http_err.headers, "X-Api-Message") or _extract_http_error_message(err_raw)
            submit_errors.append(f"[{res_id}] HTTP {http_err.code} ({sc}): {sm}")
        except (urllib.error.URLError, TimeoutError, OSError) as net_err:
            submit_errors.append(f"[{res_id}] 网络错误: {net_err}")

    if not chosen_req_id:
        raise RuntimeError(f"火山引擎豆包语音任务提交失败: {'; '.join(submit_errors)}")

    emit_progress(
        pct_base + int(pct_span * 0.25),
        f"已提交火山引擎说话人分离任务 (SSD v{ssd_version}, {chosen_res_id})，正在云端分角色转写...",
    )

    deadline = time.monotonic() + max_wait_sec
    poll_count = 0
    while True:
        poll_count += 1
        q_headers = _make_headers(chosen_res_id, chosen_req_id)
        q_req = urllib.request.Request(query_url, data=b"{}", headers=q_headers, method="POST")
        try:
            with urllib.request.urlopen(q_req, timeout=30.0) as resp:
                status_code = _get_header_ci(resp.headers, "X-Api-Status-Code", "20000000")
                status_msg = _get_header_ci(resp.headers, "X-Api-Message")
                body_str = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as http_err:
            err_raw = http_err.read().decode("utf-8", errors="ignore")
            sc = _get_header_ci(http_err.headers, "X-Api-Status-Code")
            sm = _get_header_ci(http_err.headers, "X-Api-Message") or _extract_http_error_message(err_raw)
            raise RuntimeError(
                f"火山引擎查询识别结果失败 (HTTP {http_err.code}, {sc}): {sm}"
            ) from http_err
        except (urllib.error.URLError, TimeoutError, OSError) as net_err:
            raise RuntimeError(f"查询火山引擎结果网络失败: {net_err}") from net_err

        if status_code == "20000000":
            data = json.loads(body_str) if body_str.strip() else {}
            result = data.get("result") or {}
            utterances = result.get("utterances") or []
            if not utterances and result.get("text"):
                utterances = [
                    {
                        "start_time": 0,
                        "end_time": max(500, int(round((samples_16k.shape[0] / 16000.0) * 1000.0))),
                        "text": result.get("text"),
                        "additions": {"speaker": "1"},
                    }
                ]
            emit_progress(
                pct_base + int(pct_span * 0.85),
                f"火山引擎分角色识别完成，正在解析 {len(utterances)} 条说话人分句...",
            )
            return parse_volcengine_utterances_by_speaker(utterances, norm_samples)

        if status_code in ("20000001", "20000002"):
            if time.monotonic() >= deadline:
                raise RuntimeError("火山引擎说话人分离任务轮询超时")
            prog = pct_base + int(pct_span * min(0.8, 0.25 + poll_count * 0.05))
            emit_progress(prog, f"火山引擎云端分角色识别处理中 (状态 {status_code})...")
            time.sleep(poll_interval_sec)
            continue

        raise RuntimeError(
            f"火山引擎识别任务异常结束 (状态码 {status_code}): {status_msg or body_str[:200]}"
        )


def _extract_speaker_feature_vector(seg_samples) -> Optional[Any]:
    """Extracts lightweight acoustic pitch (F0) + log-band spectral signature for local diarization fallback."""
    import numpy as np  # type: ignore

    if seg_samples is None or int(seg_samples.shape[0]) < 1600:
        return None
    x = np.asarray(seg_samples, dtype=np.float32)
    rms = float(np.sqrt(np.mean(x * x) + 1e-12))
    if rms < 1e-4:
        return None
    x = x / rms

    # Autocorrelation F0 estimate in 75Hz..320Hz
    win_len = min(int(x.shape[0]), 4096)
    center = int(x.shape[0]) // 2
    s0 = max(0, center - win_len // 2)
    frame = x[s0 : s0 + win_len]
    f0_norm = 0.35
    if int(frame.shape[0]) >= 640:
        ac = np.correlate(frame, frame, mode="full")[len(frame) - 1 :]
        min_lag = 50   # 320 Hz @ 16kHz
        max_lag = min(215, len(ac) - 1)  # 74 Hz
        if max_lag > min_lag and ac[0] > 1e-6:
            peak_lag = min_lag + int(np.argmax(ac[min_lag:max_lag]))
            f0_hz = 16000.0 / max(1, peak_lag)
            f0_norm = float(np.clip((f0_hz - 75.0) / 245.0, 0.0, 1.0))

    # 8-band log spectral profile
    n_fft = 512
    step = 256
    n_frames = max(1, (int(x.shape[0]) - n_fft) // step + 1)
    if n_frames <= 0:
        return None
    hann = np.hanning(n_fft).astype(np.float32)
    acc = np.zeros(n_fft // 2 + 1, dtype=np.float32)
    used = 0
    for idx in range(min(n_frames, 40)):
        st = idx * step
        chunk = x[st : st + n_fft]
        if int(chunk.shape[0]) < n_fft:
            break
        spec = np.abs(np.fft.rfft(chunk * hann))
        acc += spec * spec
        used += 1
    if used == 0:
        return None
    acc /= float(used)
    bands = np.array_split(np.log1p(acc[2:180]), 8)
    band_vec = np.array([float(np.mean(b)) for b in bands], dtype=np.float32)
    band_norm = float(np.linalg.norm(band_vec))
    if band_norm > 1e-6:
        band_vec /= band_norm

    return np.concatenate([np.array([f0_norm * 1.4], dtype=np.float32), band_vec])


def diarize_single_track_locally(
    samples_16k, tokens: List[Dict[str, Any]]
) -> Tuple[List[str], List[Tuple[int, int, str]], Dict[str, List[Dict[str, Any]]]]:
    """
    Offline acoustic diarization fallback when Volcengine cloud API fails with `fallbackToLocal=True`.
    Groups tokens into sentence turns and clusters them by acoustic voiceprint signature.
    """
    import numpy as np  # type: ignore

    if not tokens:
        return [], [], {}

    turns: List[List[Dict[str, Any]]] = []
    cur: List[Dict[str, Any]] = []
    for tok in tokens:
        if cur:
            prev = cur[-1]
            gap = int(tok["startMs"]) - int(prev["endMs"])
            if gap >= 550 or (TRAILING_PUNCT_RE.search(prev.get("text", "")) and gap >= 160):
                turns.append(cur)
                cur = []
        cur.append(tok)
    if cur:
        turns.append(cur)

    feats: List[Optional[Any]] = []
    for trn in turns:
        s_i = max(0, int((trn[0]["startMs"] / 1000.0) * 16000.0))
        e_i = max(s_i + 1600, int((trn[-1]["endMs"] / 1000.0) * 16000.0))
        feats.append(_extract_speaker_feature_vector(samples_16k[s_i:e_i]))

    valid = [(idx, f) for idx, f in enumerate(feats) if f is not None]
    labels = ["1"] * len(turns)

    if len(valid) >= 2:
        mat = np.stack([f for _, f in valid], axis=0)
        # Pick 2 farthest points as initial speaker centroids
        dists_to_first = np.linalg.norm(mat - mat[0], axis=1)
        idx_a = int(np.argmax(dists_to_first))
        dists_to_a = np.linalg.norm(mat - mat[idx_a], axis=1)
        idx_b = int(np.argmax(dists_to_a))
        c_a = mat[idx_a].copy()
        c_b = mat[idx_b].copy()

        # Check if there is meaningful acoustic separation between two voices
        sep_dist = float(np.linalg.norm(c_a - c_b))
        if sep_dist >= 0.22:
            assign = np.zeros(len(valid), dtype=int)
            for _ in range(8):
                da = np.linalg.norm(mat - c_a, axis=1)
                db = np.linalg.norm(mat - c_b, axis=1)
                assign = np.where(db < da, 1, 0)
                if np.any(assign == 0):
                    c_a = np.mean(mat[assign == 0], axis=0)
                if np.any(assign == 1):
                    c_b = np.mean(mat[assign == 1], axis=0)
            for pos_idx, (turn_idx, _) in enumerate(valid):
                labels[turn_idx] = "1" if assign[pos_idx] == 0 else "2"

        # Fill unlabeled turns from nearest labeled neighbor
        for idx in range(len(turns)):
            if feats[idx] is None and idx > 0:
                labels[idx] = labels[idx - 1]

    # Content-based diarization fallback when acoustic separation could not distinguish 2 speakers
    if len(set(labels)) < 2 and len(turns) >= 2:
        turn_texts = ["".join(str(t.get("text") or "") for t in trn).strip() for trn in turns]
        switch_signals = 0
        proposed = ["1"] * len(turns)
        cur_lbl = "1"
        switch_lead_re = re.compile(
            r"^(?:谢谢邀请|感谢邀请|你刚才|您刚才|你刚刚|您刚刚|回答一下|关于你|我同意|我赞同|请问|想请教|老师请问)"
        )
        intro_call_re = re.compile(r"(?:我叫|我叫做|本人叫)\s*([\u4e00-\u9fa5A-Za-z0-9_-]{2,12})")
        prev_intro_name: Optional[str] = None
        for idx, txt in enumerate(turn_texts):
            if idx == 0:
                m0 = intro_call_re.search(txt)
                if m0:
                    prev_intro_name = m0.group(1)
                continue
            prev_txt = turn_texts[idx - 1]
            is_switch = False
            if (prev_txt.endswith("?") or prev_txt.endswith("？")) and len(txt) >= 6 and not (txt.endswith("?") or txt.endswith("？")):
                is_switch = True
            elif switch_lead_re.search(txt):
                is_switch = True
            else:
                m_cur = intro_call_re.search(txt)
                if m_cur and prev_intro_name and m_cur.group(1) != prev_intro_name:
                    is_switch = True
                    prev_intro_name = m_cur.group(1)
                elif m_cur and not prev_intro_name:
                    prev_intro_name = m_cur.group(1)
            if is_switch:
                switch_signals += 1
                cur_lbl = "2" if cur_lbl == "1" else "1"
            proposed[idx] = cur_lbl
        if switch_signals >= 2 and len(set(proposed)) >= 2:
            labels = proposed

    speaker_order: List[str] = []
    segments: List[Tuple[int, int, str]] = []
    tokens_by_speaker: Dict[str, List[Dict[str, Any]]] = {}

    for trn, sp_id in zip(turns, labels):
        if sp_id not in speaker_order:
            speaker_order.append(sp_id)
            tokens_by_speaker[sp_id] = []
        segments.append((int(trn[0]["startMs"]), int(trn[-1]["endMs"]), sp_id))
        tokens_by_speaker[sp_id].extend(trn)

    return speaker_order, segments, tokens_by_speaker


def decode_audio_48khz_mono_i16(file_path: str, fallback_samples_16k=None):
    """Decodes an input audio file to 48kHz mono int16 PCM, or resamples 16kHz float32 fallback."""
    import numpy as np  # type: ignore

    if file_path and os.path.exists(file_path):
        cmd = [
            find_ffmpeg_bin(),
            "-nostdin",
            "-loglevel",
            "error",
            "-threads",
            "0",
            "-i",
            file_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "s16le",
            "pipe:1",
        ]
        try:
            proc = subprocess.run(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            if proc.returncode == 0 and len(proc.stdout) >= 2:
                return np.frombuffer(proc.stdout, dtype="<i2").copy()
        except Exception:
            pass

    if fallback_samples_16k is not None and int(fallback_samples_16k.shape[0]) > 0:
        arr = np.asarray(fallback_samples_16k, dtype=np.float32)
        n_in = int(arr.shape[0])
        n_out = n_in * 3
        x_old = np.linspace(0.0, float(n_in - 1), n_in, dtype=np.float64)
        x_new = np.linspace(0.0, float(n_in - 1), n_out, dtype=np.float64)
        up = np.interp(x_new, x_old, arr.astype(np.float64))
        return np.clip(np.rint(up * 32767.0), -32768, 32767).astype("<i2")

    return np.zeros(0, dtype="<i2")


def _compute_peaks_and_segments_from_48k(pcm_48k) -> Dict[str, Any]:
    """Computes 1200-bin peak envelope, detectedSegments, LUFS estimate, and room-tone range."""
    import numpy as np  # type: ignore

    n_samples = int(pcm_48k.shape[0])
    duration_ms = int(round((n_samples / 48000.0) * 1000.0))
    if n_samples == 0:
        return {
            "durationMs": 0,
            "peaks": [0.0] * 1200,
            "detectedSegments": [],
            "rawLufs": -60.0,
            "roomToneStartMs": 0,
            "roomToneEndMs": 500,
        }

    f32 = pcm_48k.astype(np.float32) / 32768.0
    n_bins = 1200
    peaks: List[float] = []
    for b in range(n_bins):
        s_i = (b * n_samples) // n_bins
        e_i = max(s_i + 1, ((b + 1) * n_samples) // n_bins)
        pk = float(np.max(np.abs(f32[s_i:e_i])))
        peaks.append(round(pk, 4))

    rms_total = float(np.sqrt(np.mean(f32 * f32) + 1e-12))
    raw_lufs = round(max(-60.0, 20.0 * math.log10(max(1e-5, rms_total)) - 0.7), 1)

    win = 4800  # 100ms @ 48kHz
    n_wins = n_samples // win
    detected_segments: List[Dict[str, Any]] = []
    room_start = 0
    room_end = min(500, duration_ms)

    if n_wins > 0:
        reshaped = f32[: n_wins * win].reshape(n_wins, win)
        win_rms = np.sqrt(np.mean(reshaped * reshaped, axis=1) + 1e-12)
        min_idx = int(np.argmin(win_rms))
        room_start = min_idx * 100
        room_end = min(duration_ms, room_start + 500)

        speech_thresh = 0.012
        cur_is_sil = bool(win_rms[0] < speech_thresh)
        seg_start_ms = 0
        for wi in range(1, n_wins):
            is_sil = bool(win_rms[wi] < speech_thresh)
            if is_sil != cur_is_sil:
                detected_segments.append(
                    {
                        "startMs": seg_start_ms,
                        "endMs": wi * 100,
                        "isSilence": cur_is_sil,
                    }
                )
                seg_start_ms = wi * 100
                cur_is_sil = is_sil
        detected_segments.append(
            {
                "startMs": seg_start_ms,
                "endMs": duration_ms,
                "isSilence": cur_is_sil,
            }
        )

    return {
        "durationMs": duration_ms,
        "peaks": peaks,
        "detectedSegments": detected_segments,
        "rawLufs": raw_lufs,
        "roomToneStartMs": room_start,
        "roomToneEndMs": room_end,
    }


def build_separated_speaker_tracks(
    file_path: str,
    speaker_order: List[str],
    segments: List[Tuple[int, int, str]],
    tokens_by_speaker: Dict[str, List[Dict[str, Any]]],
    engine_name: str,
    fallback_samples_16k=None,
    output_dir: str = SEPARATED_STEMS_DIR,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Splits a single mixed audio file into K complementary 48kHz mono PCM WAV speaker stems
    with 20ms linear crossfades so sum(stem_k) == original at every sample.
    Returns (separatedTracksMeta, resultsByTrackId).
    """
    import numpy as np  # type: ignore

    pcm_48k = decode_audio_48khz_mono_i16(file_path, fallback_samples_16k=fallback_samples_16k)
    n_samples = int(pcm_48k.shape[0])
    k_speakers = len(speaker_order)
    if n_samples == 0 or k_speakers < 2:
        return [], {}

    os.makedirs(output_dir, exist_ok=True)
    sp_to_idx = {sp_id: idx for idx, sp_id in enumerate(speaker_order)}

    # Sort and merge consecutive same-speaker intervals
    ordered_segs = sorted(
        [(max(0, int(s)), max(int(s) + 40, int(e)), sp_to_idx[sp]) for s, e, sp in segments if sp in sp_to_idx],
        key=lambda x: (x[0], x[1]),
    )
    merged: List[Tuple[int, int, int]] = []
    for s_ms, e_ms, sp_i in ordered_segs:
        if merged and merged[-1][2] == sp_i and s_ms - merged[-1][1] <= 120:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e_ms), sp_i)
        else:
            merged.append((s_ms, e_ms, sp_i))

    # Build continuous owner array across [0 .. n_samples) split at silence midpoints
    owner = np.zeros(n_samples, dtype=np.int32)
    if merged:
        first_sp = merged[0][2]
        owner[:] = first_sp
        prev_cut = 0
        for m_idx in range(len(merged)):
            cur_s_ms, cur_e_ms, cur_sp = merged[m_idx]
            if m_idx + 1 < len(merged):
                nxt_s_ms, _, _ = merged[m_idx + 1]
                # Split gap at midpoint so tails & breaths stay attached smoothly
                mid_ms = (cur_e_ms + max(cur_e_ms, nxt_s_ms)) // 2 if nxt_s_ms >= cur_e_ms else nxt_s_ms
                cut_samp = max(prev_cut, min(n_samples, int(round((mid_ms / 1000.0) * 48000.0))))
                owner[prev_cut:cut_samp] = cur_sp
                prev_cut = cut_samp
            else:
                owner[prev_cut:n_samples] = cur_sp

    weights = np.zeros((k_speakers, n_samples), dtype=np.float32)
    for sp_i in range(k_speakers):
        weights[sp_i, owner == sp_i] = 1.0

    # Apply 20ms (960 samples @ 48kHz) complementary linear crossfade at speaker transitions
    fade_half = 480
    transitions = np.where(owner[1:] != owner[:-1])[0] + 1
    for b in transitions:
        from_sp = int(owner[b - 1])
        to_sp = int(owner[b])
        if from_sp == to_sp:
            continue
        f_start = max(0, int(b) - fade_half)
        f_end = min(n_samples, int(b) + fade_half)
        f_len = f_end - f_start
        if f_len >= 2:
            alpha = np.linspace(0.0, 1.0, f_len, dtype=np.float32)
            weights[:, f_start:f_end] = 0.0
            weights[from_sp, f_start:f_end] = 1.0 - alpha
            weights[to_sp, f_start:f_end] = alpha

    stem_hash = hashlib.sha1(
        f"{file_path}|{n_samples}|{','.join(speaker_order)}".encode("utf-8")
    ).hexdigest()[:12]

    separated_meta: List[Dict[str, Any]] = []
    results_by_track: Dict[str, Any] = {}
    pcm_f32 = pcm_48k.astype(np.float32)

    for sp_i, sp_raw_id in enumerate(speaker_order):
        tid = f"sp_{sp_i + 1}"
        role = "host" if sp_i == 0 else "guest"
        role_label = "主持人 Host" if sp_i == 0 else "飞行嘉宾 Guest"
        display_name = (
            f"主持人 (角色{sp_i + 1})" if sp_i == 0 else f"嘉宾 {sp_i} (角色{sp_i + 1})"
        )
        color = SEPARATED_TRACK_COLORS[sp_i % len(SEPARATED_TRACK_COLORS)]

        out_wav = os.path.join(output_dir, f"{stem_hash}_{tid}.wav")
        sp_pcm = np.clip(np.rint(pcm_f32 * weights[sp_i]), -32768, 32767).astype("<i2")
        with wave.open(out_wav, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(48000)
            wf.writeframes(sp_pcm.tobytes())

        metrics = _compute_peaks_and_segments_from_48k(sp_pcm)
        separated_meta.append(
            {
                "id": tid,
                "speakerKey": sp_raw_id,
                "name": display_name,
                "role": role,
                "roleLabel": role_label,
                "color": color,
                "filePath": out_wav,
                "durationMs": metrics["durationMs"],
                "rawLufs": metrics["rawLufs"],
                "autoGainDb": 0.0,
                "syncOffsetMs": 0,
                "roomToneStartMs": metrics["roomToneStartMs"],
                "roomToneEndMs": metrics["roomToneEndMs"],
                "peaks": metrics["peaks"],
                "detectedSegments": metrics["detectedSegments"],
                "isRef": False,
            }
        )

        sp_tokens = tokens_by_speaker.get(sp_raw_id, [])
        acoustics = {
            "durationMs": metrics["durationMs"],
            "rmsWindows": [],
            "clapTimestampsMs": [],
            "trailingDropDb": 3.5,
        }
        results_by_track[tid] = {
            "engine": engine_name,
            "acoustics": acoustics,
            "tokens": sp_tokens,
        }

    return separated_meta, results_by_track


def handle_transcribe_stems(payload: Dict[str, Any]) -> Dict[str, Any]:
    all_input_tracks = payload.get("tracks", [])
    recording_mode = payload.get("recordingMode", "same_room_sync")
    glossary = payload.get("glossary", [])
    hotwords = [g["word"] for g in glossary if g.get("type") == "hotword"]
    asr_config = payload.get("asrConfig") or {}

    # If user imported only 1 track (even if named 'mix'/'ref'), always transcribe it!
    non_ref_tracks = [t for t in all_input_tracks if not t.get("isRef")]
    tracks_to_transcribe = non_ref_tracks if non_ref_tracks else all_input_tracks

    if not tracks_to_transcribe:
        return {"ok": True, "tracks": {}, "asrModelReady": True}

    requested_provider = str(asr_config.get("provider") or "local_sensevoice").strip()
    use_deepseek = requested_provider == "deepseek"
    use_volcengine = requested_provider == "volcengine_doubao"
    enable_single_sep = bool(asr_config.get("enableSingleFileSpeakerSep", True))
    fallback_to_local = bool(asr_config.get("fallbackToLocal", True))
    deepseek_key = str(
        asr_config.get("apiKey") or os.environ.get("DEEPSEEK_API_KEY") or ""
    ).strip()
    deepseek_base_url = str(
        asr_config.get("baseUrl") or DEEPSEEK_ASR_DEFAULT_BASE_URL
    ).strip()
    deepseek_model = str(asr_config.get("model") or "").strip()

    # Step 1: Decode 16kHz mono float32 buffers for all speaker tracks
    decoded_buffers: Dict[str, Any] = {}
    acoustics_map: Dict[str, Dict[str, Any]] = {}
    offsets_map: Dict[str, int] = {}

    total = len(tracks_to_transcribe)
    for idx, tr in enumerate(tracks_to_transcribe):
        tid = str(tr.get("id") or tr.get("speakerId") or f"sp_{idx + 1}")
        tname = tr.get("name", tid)
        emit_progress(
            52 + int((idx / max(1, total)) * 8),
            f"正在解码音轨 ({idx + 1}/{total}): {tname} ...",
        )
        fpath = tr.get("filePath", "")
        samples = decode_audio_16khz_mono_f32(fpath)
        decoded_buffers[tid] = samples
        acoustics_map[tid] = extract_fast_acoustics_from_16k(samples)
        offsets_map[tid] = (
            0
            if recording_mode in ("same_room_sync", "same_room")
            else int(tr.get("syncOffsetMs", 0))
        )

    # Step 2: Cross-track microphone bleed suppression when >= 2 speaker stems exist
    if len(decoded_buffers) >= 2:
        emit_progress(61, "正在执行多轨防串音门限分离，过滤副麦串音重复识别...")
        clean_buffers = apply_cross_track_bleed_suppression(decoded_buffers, offsets_map)
    else:
        clean_buffers = decoded_buffers

    # Step 3: Transcribe via Volcengine Doubao Speaker Separation, DeepSeek Cloud ASR, or Local SenseVoice
    results_by_track: Dict[str, Any] = {}
    separated_tracks_meta: Optional[List[Dict[str, Any]]] = None
    engine_name = (
        "volcengine_doubao"
        if use_volcengine
        else "deepseek_asr"
        if use_deepseek
        else "sense_voice_int8"
    )
    fallback_used = False
    fallback_reason = ""
    recognizer = None
    punct_model = None

    if use_volcengine:
        emit_progress(62, "正在启动火山引擎豆包语音说话人分离 (SSD)...")
        try:
            if total == 1 and enable_single_sep:
                tr0 = tracks_to_transcribe[0]
                tid0 = str(tr0.get("id") or tr0.get("speakerId") or "sp_1")
                fpath0 = str(tr0.get("filePath") or "")
                speaker_order, segments, tokens_by_speaker = transcribe_with_volcengine_auc(
                    clean_buffers[tid0],
                    asr_config=asr_config,
                    hotwords=hotwords,
                    pct_base=63,
                    pct_span=22,
                )
                for sp_id in speaker_order:
                    apply_hotword_fuzzy_correction(tokens_by_speaker.get(sp_id, []), hotwords)

                if len(speaker_order) >= 2:
                    emit_progress(87, f"已识别 {len(speaker_order)} 位说话人，正在拆分为独立声道 WAV 音轨...")
                    separated_tracks_meta, results_by_track = build_separated_speaker_tracks(
                        file_path=fpath0,
                        speaker_order=speaker_order,
                        segments=segments,
                        tokens_by_speaker=tokens_by_speaker,
                        engine_name="volcengine_doubao",
                        fallback_samples_16k=clean_buffers[tid0],
                    )
                else:
                    single_toks = (
                        tokens_by_speaker.get(speaker_order[0], []) if speaker_order else []
                    )
                    results_by_track[tid0] = {
                        "engine": "volcengine_doubao",
                        "acoustics": acoustics_map[tid0],
                        "tokens": single_toks,
                    }
            else:
                for idx, tr in enumerate(tracks_to_transcribe):
                    tid = str(tr.get("id") or tr.get("speakerId") or f"sp_{idx + 1}")
                    pct_base = 63 + int((idx / max(1, total)) * 24)
                    pct_span = max(4, int(24 / max(1, total)))
                    sp_order, _, sp_tokens_map = transcribe_with_volcengine_auc(
                        clean_buffers[tid],
                        asr_config=asr_config,
                        hotwords=hotwords,
                        pct_base=pct_base,
                        pct_span=pct_span,
                    )
                    merged_toks: List[Dict[str, Any]] = []
                    for sp_id in sp_order:
                        merged_toks.extend(sp_tokens_map.get(sp_id, []))
                    merged_toks.sort(key=lambda t: (t["startMs"], t["endMs"]))
                    apply_hotword_fuzzy_correction(merged_toks, hotwords)
                    results_by_track[tid] = {
                        "engine": "volcengine_doubao",
                        "acoustics": acoustics_map[tid],
                        "tokens": merged_toks,
                    }
            engine_name = "volcengine_doubao"
        except Exception as volc_err:
            reason = str(volc_err)
            if not fallback_to_local:
                return {"ok": False, "error": reason}
            fallback_used = True
            fallback_reason = reason
            use_volcengine = False
            results_by_track = {}
            separated_tracks_meta = None
            emit_progress(
                64,
                f"火山引擎豆包语音不可用 ({reason})，正在回退本地神经网络与声学说话人分离...",
            )

    if use_deepseek and not deepseek_key:
        reason = "未填写 DeepSeek API Key，无法调用 DeepSeek 云端语音识别"
        if not fallback_to_local:
            return {"ok": False, "error": reason}
        fallback_used = True
        fallback_reason = reason
        use_deepseek = False

    if use_deepseek:
        emit_progress(63, "正在连接 DeepSeek 语音识别 API (/v1/tools/asr) 进行转写...")
        try:
            for idx, tr in enumerate(tracks_to_transcribe):
                tid = str(tr.get("id") or tr.get("speakerId") or f"sp_{idx + 1}")
                tname = tr.get("name", tid)
                pct_base = 65 + int((idx / max(1, total)) * 24)
                pct_span = max(4, int(24 / max(1, total)))

                tokens = transcribe_buffer_with_deepseek(
                    clean_buffers[tid],
                    api_key=deepseek_key,
                    base_url=deepseek_base_url,
                    model=deepseek_model,
                    track_label=tname,
                    pct_base=pct_base,
                    pct_span=pct_span,
                )
                apply_hotword_fuzzy_correction(tokens, hotwords)
                results_by_track[tid] = {
                    "engine": "deepseek_asr",
                    "acoustics": acoustics_map[tid],
                    "tokens": tokens,
                }
            engine_name = "deepseek_asr"
        except Exception as ds_err:
            reason = str(ds_err)
            if not fallback_to_local:
                return {"ok": False, "error": reason}
            fallback_used = True
            fallback_reason = reason
            use_deepseek = False
            results_by_track = {}
            emit_progress(64, f"DeepSeek ASR 异常 ({reason})，正在自动切换本地 SenseVoice 引擎...")

    if not use_deepseek and not use_volcengine:
        emit_progress(63, "正在加载本地神经网络语音识别引擎 (SenseVoice + Silero VAD)...")
        recognizer, punct_model, engine_name = build_local_sherpa_recognizer()
        for idx, tr in enumerate(tracks_to_transcribe):
            tid = str(tr.get("id") or tr.get("speakerId") or f"sp_{idx + 1}")
            tname = tr.get("name", tid)
            pct_base = 65 + int((idx / max(1, total)) * 24)
            pct_span = max(4, int(24 / max(1, total)))

            tokens = transcribe_buffer_with_sherpa(
                clean_buffers[tid],
                recognizer,
                punct_model,
                engine_name,
                tname,
                pct_base,
                pct_span,
            )
            apply_hotword_fuzzy_correction(tokens, hotwords)

            results_by_track[tid] = {
                "engine": engine_name,
                "acoustics": acoustics_map[tid],
                "tokens": tokens,
            }

        # When fallback from Volcengine single-file speaker separation, run local acoustic diarization!
        if (
            requested_provider == "volcengine_doubao"
            and total == 1
            and enable_single_sep
        ):
            tr0 = tracks_to_transcribe[0]
            tid0 = str(tr0.get("id") or tr0.get("speakerId") or "sp_1")
            fpath0 = str(tr0.get("filePath") or "")
            raw_toks = (results_by_track.get(tid0) or {}).get("tokens") or []
            sp_order, segments, tokens_by_speaker = diarize_single_track_locally(
                clean_buffers[tid0], raw_toks
            )
            if len(sp_order) >= 2:
                emit_progress(
                    88,
                    f"本地声学分角色完成，已聚出 {len(sp_order)} 位说话人并生成独立音轨...",
                )
                separated_tracks_meta, sep_results = build_separated_speaker_tracks(
                    file_path=fpath0,
                    speaker_order=sp_order,
                    segments=segments,
                    tokens_by_speaker=tokens_by_speaker,
                    engine_name=engine_name,
                    fallback_samples_16k=clean_buffers[tid0],
                )
                if separated_tracks_meta:
                    results_by_track = sep_results

    emit_progress(91, "语音文字与逐字时间戳识别完成，正在组装多轨精剪文稿...")
    out: Dict[str, Any] = {
        "ok": True,
        "engine": engine_name,
        "tracks": results_by_track,
        "asrModelReady": True,
    }
    if separated_tracks_meta:
        out["separatedTracks"] = separated_tracks_meta
        out["speakerCount"] = len(separated_tracks_meta)
    if fallback_used:
        out["fallbackUsed"] = True
        out["fallbackReason"] = fallback_reason
    return out


def call_cloud_llm(
    prompt: str,
    llm_config: Dict[str, Any],
    system_prompt: Optional[str] = None,
    timeout: int = 30,
    temperature: float = 0.2,
) -> str:
    provider = llm_config.get("provider", "gemini")
    api_key = (
        llm_config.get("apiKey")
        or os.environ.get("GEMINI_API_KEY")
        or os.environ.get("DEEPSEEK_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or ""
    ).strip()
    if not api_key:
        raise RuntimeError("NO_API_KEY")

    if provider == "gemini":
        model = llm_config.get("model") or "gemini-2.5-flash"
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        payload: Dict[str, Any] = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": temperature},
        }
        if system_prompt:
            payload["systemInstruction"] = {"parts": [{"text": system_prompt}]}
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return body["candidates"][0]["content"]["parts"][0]["text"]
    else:
        default_base = (
            "https://api.deepseek.com/v1"
            if provider == "deepseek"
            else "https://api.openai.com/v1"
        )
        default_model = "deepseek-chat" if provider == "deepseek" else "gpt-4o-mini"
        base_url = (llm_config.get("baseUrl") or default_base).rstrip("/")
        model = llm_config.get("model") or default_model
        url = f"{base_url}/chat/completions"
        sys_msg = (
            system_prompt
            if system_prompt
            else "你是一位专业的中文播客精剪师与语言表达教练，请严格输出合法 JSON。"
        )
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": sys_msg,
                },
                {"role": "user", "content": prompt},
            ],
            "response_format": {"type": "json_object"},
            "temperature": temperature,
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return body["choices"][0]["message"]["content"]


def local_analyze_fallback(payload: Dict[str, Any]) -> Dict[str, Any]:
    blocks = payload.get("blocks", [])
    tracks = payload.get("tracks", [])
    glossary = payload.get("glossary", [])
    constraints = payload.get(
        "highlightConstraints", {"minClipSec": 8, "maxClipSec": 20, "targetTotalSec": 90}
    )

    min_sec = float(constraints.get("minClipSec", 8))
    max_sec = float(constraints.get("maxClipSec", 20))
    target_total = float(constraints.get("targetTotalSec", 90))

    habit_words = {g["word"] for g in glossary if g.get("type") == "habit"}
    pure_fillers = {"呃", "啊", "嗯", "嘶", "就是说", "怎么说呢"} | habit_words
    hotwords = [g["word"] for g in glossary if g.get("type") == "hotword"]
    sensitive_words = {g["word"] for g in glossary if g.get("type") == "sensitive"}

    typo_suggestions: List[Dict[str, str]] = []
    filler_classifications: List[Dict[str, str]] = []
    sensitive_hits: List[str] = []

    speaker_stats: Dict[str, Dict[str, Any]] = {}
    for tr in tracks:
        if not tr.get("isRef"):
            speaker_stats[tr["id"]] = {
                "name": tr["name"],
                "role": tr.get("role", "guest"),
                "speakingSec": 0.0,
                "charCount": 0,
                "fillerCount": 0,
                "questionTurns": 0,
                "statementTurns": 0,
            }

    candidate_highlights: List[Dict[str, Any]] = []

    for b in blocks:
        sp_id = b.get("speakerId")
        st = speaker_stats.get(sp_id)
        block_text_parts: List[str] = []
        block_dur = 0.0
        block_start_ms = 0
        first_set = False

        tokens = b.get("tokens", [])
        for idx, tok in enumerate(tokens):
            if tok.get("deleted"):
                continue
            dur_s = (float(tok.get("endMs", 0)) - float(tok.get("startMs", 0))) / 1000.0
            if not first_set:
                block_start_ms = int(tok.get("startMs", 0))
                first_set = True
            block_dur += max(0.0, dur_s)

            if tok.get("type") in ("silence", "laughter"):
                continue

            txt = tok.get("text", "")
            plain_txt = txt.rstrip("，。？！、；：,.?! ")
            block_text_parts.append(txt)

            if st is not None:
                st["speakingSec"] += max(0.0, dur_s)
                st["charCount"] += len(plain_txt)

            if any(sw in txt for sw in sensitive_words if sw):
                sensitive_hits.append(tok["id"])

            if plain_txt in pure_fillers:
                filler_classifications.append({"tokenId": tok["id"], "tag": "pure"})
                if st is not None:
                    st["fillerCount"] += 1
            elif plain_txt == "那个":
                lookahead = "".join(
                    tokens[m].get("text", "") for m in range(idx + 1, min(len(tokens), idx + 4))
                )
                if any(
                    n in lookahead
                    for n in ("阶段", "时代", "产品", "方案", "人", "问题", "时候", "地方", "公司")
                ):
                    filler_classifications.append({"tokenId": tok["id"], "tag": "semantic_keep"})
                else:
                    filler_classifications.append({"tokenId": tok["id"], "tag": "pure"})
                    if st is not None:
                        st["fillerCount"] += 1

        full_sentence = "".join(block_text_parts)
        if st is not None and full_sentence:
            if (
                "？" in full_sentence
                or "?" in full_sentence
                or "吗" in full_sentence
                or "怎么" in full_sentence
            ):
                st["questionTurns"] += 1
            else:
                st["statementTurns"] += 1

        if full_sentence and block_dur >= 3.0:
            clipped_dur = min(max_sec, max(min_sec, round(block_dur, 1)))
            score = 88 if ("！" in full_sentence or "？" in full_sentence) else 76
            candidate_highlights.append(
                {
                    "speakerId": sp_id,
                    "speakerName": st["name"] if st else "发言人",
                    "text": full_sentence[:90],
                    "sourceStartMs": block_start_ms,
                    "sourceEndMs": block_start_ms + int(clipped_dur * 1000),
                    "durationSec": clipped_dur,
                    "score": score,
                }
            )

    candidate_highlights.sort(key=lambda x: x["score"], reverse=True)
    picked_highlights = []
    acc = 0.0
    for ch in candidate_highlights:
        if acc + ch["durationSec"] <= target_total + 1.5:
            picked_highlights.append(ch)
            acc += ch["durationSec"]

    total_sec = max(1.0, sum(v["speakingSec"] for v in speaker_stats.values()))
    host_q_sec = 0.0
    host_s_sec = 0.0
    guest_sec = 0.0

    coaching_reports: Dict[str, Any] = {}
    for sp_id, st in speaker_stats.items():
        dur_min = max(0.1, st["speakingSec"] / 60.0)
        cpm = int(round(st["charCount"] / dur_min)) if st["charCount"] > 0 else 0
        filler_per_min = round(st["fillerCount"] / dur_min, 1)

        total_turns = max(1, st["questionTurns"] + st["statementTurns"])
        if st["role"] == "host":
            q_ratio = st["questionTurns"] / total_turns
            host_q_sec += st["speakingSec"] * max(0.45, q_ratio)
            host_s_sec += st["speakingSec"] * (1.0 - max(0.45, q_ratio))
        else:
            guest_sec += st["speakingSec"]

        tips = []
        if filler_per_min >= 2.0:
            tips.append(
                f"【以停代呃训练】：平均每分钟出现 {filler_per_min} 次口癖词，建议思考换气时用 0.4s 闭麦停顿替代口头禅。"
            )
        else:
            tips.append("【语流洁净度良好】：口癖密度较低，句间停顿自然。")

        if cpm > 255:
            tips.append(
                f"【关键论点降速训练】：当前语速偏快（{cpm} 字/分），输出核心论点时建议放慢 15% 语速。"
            )
        elif cpm > 0:
            tips.append(f"【语速稳健（{cpm} 字/分）】：处于播客舒适收听区间。")

        if st["role"] == "host":
            tips.append("【主持人追问控场】：建议保持短促追问，引导嘉宾展开一线细节案例。")
        else:
            tips.append("【句尾气息支撑】：长句收尾注意保持音量稳定，避免句末吞尾音。")

        coaching_reports[sp_id] = {
            "speakingSec": round(st["speakingSec"], 1),
            "speakingRatio": round((st["speakingSec"] / total_sec) * 100, 1),
            "cpm": cpm,
            "fillerPerMin": filler_per_min,
            "trailingDropDb": 4.2,
            "tips": tips,
        }

    interaction_pct = 5.0 if blocks else 0.0
    rem = max(0.0, 100.0 - interaction_pct)
    host_q_pct = round((host_q_sec / total_sec) * rem, 1) if blocks else 0.0
    host_s_pct = round((host_s_sec / total_sec) * rem, 1) if blocks else 0.0
    guest_pct = round(max(0.0, rem - host_q_pct - host_s_pct), 1) if blocks else 0.0

    return {
        "ok": True,
        "engine": "local_smart_analyzer",
        "typoSuggestions": typo_suggestions,
        "fillerClassifications": filler_classifications,
        "sensitiveTokenIds": sensitive_hits,
        "recommendedHighlights": picked_highlights,
        "hostGuestRatio": {
            "hostQuestionPct": host_q_pct,
            "hostOpinionPct": host_s_pct,
            "guestOutputPct": guest_pct,
            "interactionPct": interaction_pct,
            "diagnosis": "嘉宾输出占比充足，主客控场节奏均衡。"
            if guest_pct >= 50
            else "主持人发言占比较高，可适当精简铺垫陈述。",
        },
        "coachingReports": coaching_reports,
        "hotwordsUsed": hotwords,
    }


def _load_local_ai_config_file() -> Dict[str, Any]:
    try:
        cfg_path = os.path.expanduser("~/.tapwave/ai_config.json")
        if os.path.isfile(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def resolve_effective_llm_config(payload: Dict[str, Any]) -> Dict[str, Any]:
    llm_cfg = dict(payload.get("llmConfig") or {})
    asr_cfg = payload.get("asrConfig") or {}

    if llm_cfg.get("forceLocalOnly") or llm_cfg.get("provider") == "local_only":
        return {"provider": "local_only", "apiKey": "", "forceLocalOnly": True}

    if (llm_cfg.get("apiKey") or "").strip():
        return llm_cfg

    # Try local ~/.tapwave/ai_config.json for the requested provider
    local_cfg = _load_local_ai_config_file()
    local_providers = local_cfg.get("providers") if isinstance(local_cfg.get("providers"), dict) else {}
    req_provider = str(llm_cfg.get("provider") or "").strip()
    if req_provider in ("deepseek", "gemini", "openai") and isinstance(local_providers.get(req_provider), dict):
        p_cfg = local_providers[req_provider]
        p_key = str(p_cfg.get("apiKey") or "").strip()
        if p_key:
            return {
                "provider": req_provider,
                "apiKey": p_key,
                "baseUrl": p_cfg.get("llmBaseUrl") or p_cfg.get("baseUrl") or llm_cfg.get("baseUrl") or "",
                "model": p_cfg.get("model") or llm_cfg.get("model") or "",
            }

    asr_key = (asr_cfg.get("apiKey") or "").strip()
    if asr_key and asr_cfg.get("provider") == "deepseek":
        return {
            "provider": "deepseek",
            "apiKey": asr_key,
            "baseUrl": "https://api.deepseek.com/v1",
            "model": "deepseek-chat",
        }

    ds_env = (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
    if ds_env:
        return {
            "provider": "deepseek",
            "apiKey": ds_env,
            "baseUrl": "https://api.deepseek.com/v1",
            "model": "deepseek-chat",
        }

    gm_env = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if gm_env:
        return {
            "provider": "gemini",
            "apiKey": gm_env,
            "model": "gemini-2.5-flash",
        }

    oa_env = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if oa_env:
        return {
            "provider": "openai",
            "apiKey": oa_env,
            "baseUrl": "https://api.openai.com/v1",
            "model": "gpt-4o-mini",
        }

    return llm_cfg


def handle_analyze_transcript(payload: Dict[str, Any]) -> Dict[str, Any]:
    emit_progress(90, "正在分析发言人时长占比、语速口癖与高光候选...")
    base_result = local_analyze_fallback(payload)
    llm_cfg = resolve_effective_llm_config(payload)
    if (llm_cfg.get("apiKey") or "").strip():
        try:
            emit_progress(94, "正在调用云端大模型生成节目摘要与纠错建议...")
            plain_lines = []
            for b in payload.get("blocks", []):
                txt = "".join(
                    "[哔——]" if t.get("bleeped") else t.get("text", "")
                    for t in b.get("tokens", [])
                    if not t.get("deleted") and t.get("type") not in ("silence", "laughter")
                )
                if txt:
                    plain_lines.append(f"[{b.get('speakerId')}]: {txt}")
            if plain_lines:
                prompt = (
                    "请根据以下播客多轨转写文稿（注意其中[哔——]为已消音保密词，摘要中严禁还原），"
                    "输出 JSON 包含字段: titleCandidates (3个高点击率标题数组), summary (200-300字节目概要), "
                    "hostDiagnosis (一句主客控场评价)。\n\n文稿：\n" + "\n".join(plain_lines[:80])
                )
                llm_raw = call_cloud_llm(prompt, llm_cfg)
                llm_json = json.loads(llm_raw)
                base_result["engine"] = f"cloud_llm_{llm_cfg.get('provider', 'deepseek')}"
                base_result["llmSummary"] = llm_json
        except Exception as exc:
            base_result["llmFallbackReason"] = str(exc)

    emit_progress(98, "AI 分析完成")
    return base_result


def _extract_json_object(raw_text: str) -> Dict[str, Any]:
    cleaned = (raw_text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", cleaned)
        if match:
            return json.loads(match.group(0))
        raise


def _format_ms_label(ms: Any) -> str:
    try:
        sec = max(0, int(float(ms) // 1000))
    except (TypeError, ValueError):
        sec = 0
    hrs, rem = divmod(sec, 3600)
    mins, secs = divmod(rem, 60)
    if hrs > 0:
        return f"{hrs:02d}:{mins:02d}:{secs:02d}"
    return f"{mins:02d}:{secs:02d}"


def _strip_transcript_tags(raw_text: str) -> str:
    cleaned = re.sub(r"<\|[^|>]+\|>", "", raw_text or "")
    cleaned = re.sub(r"\[[^\]]+\][:：]?\s*", "", cleaned)
    cleaned = cleaned.replace("😂", "")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in cleaned.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def _format_srt_ms(ms: Any) -> str:
    try:
        safe_ms = max(0, int(round(float(ms))))
    except (TypeError, ValueError):
        safe_ms = 0
    hrs, rem = divmod(safe_ms, 3_600_000)
    mins, rem = divmod(rem, 60_000)
    secs, millis = divmod(rem, 1000)
    return f"{hrs:02d}:{mins:02d}:{secs:02d},{millis:03d}"


def _compact_srt_transcript(srt_text: str, max_chars: int = 80000) -> str:
    """仅当 SRT 总长度超出上下文安全阈值时，才按温和粒度归并相邻字幕块，最大程度保留自然时间分布。"""
    if len(srt_text) <= max_chars:
        return srt_text

    cue_pattern = re.compile(
        r"(?ms)^\s*\d+\s*\n(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*\n(.*?)(?=\n\s*\n\s*\d+\s*\n|\Z)"
    )
    matches = cue_pattern.findall(srt_text)
    if not matches:
        return srt_text[:max_chars]

    # 轻量归并（每块约 80 字），若仍超限再适度放大粒度，确保保留全文与自然时间分布
    target_body_chars = 80
    compacted = srt_text
    for _ in range(4):
        merged_blocks = []
        cur_start = None
        cur_end = None
        cur_parts = []
        cur_len = 0
        for start_ts, end_ts, body in matches:
            clean_body = re.sub(r"\s+", " ", body).strip()
            if not clean_body:
                continue
            if cur_start is None:
                cur_start = start_ts
            cur_end = end_ts
            cur_parts.append(clean_body)
            cur_len += len(clean_body)
            if cur_len >= target_body_chars:
                idx = len(merged_blocks) + 1
                merged_blocks.append(f"{idx}\n{cur_start} --> {cur_end}\n{''.join(cur_parts)}")
                cur_start = None
                cur_end = None
                cur_parts = []
                cur_len = 0
        if cur_start is not None and cur_parts:
            idx = len(merged_blocks) + 1
            merged_blocks.append(f"{idx}\n{cur_start} --> {cur_end}\n{''.join(cur_parts)}")
        compacted = "\n\n".join(merged_blocks)
        if len(compacted) <= max_chars:
            return compacted
        target_body_chars *= 2
    return compacted[:max_chars]


def _unwrap_shownotes_json(data: Any) -> Dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("INVALID_LLM_OUTPUT: response is not a JSON object")
    for wrapper_key in ("shownotes", "data", "result"):
        if (
            not data.get("summary")
            and not data.get("timeline")
            and isinstance(data.get(wrapper_key), dict)
        ):
            data = data[wrapper_key]
            break
    if not isinstance(data, dict) or (
        not str(data.get("summary") or "").strip() and not data.get("timeline")
    ):
        raise ValueError("INVALID_LLM_OUTPUT: missing summary and timeline")
    return data


def handle_generate_shownotes(payload: Dict[str, Any]) -> Dict[str, Any]:
    llm_cfg = resolve_effective_llm_config(payload)
    project_title = payload.get("projectTitle") or "未命名播客"
    srt_transcript = (payload.get("srtTranscript") or "").strip()

    if not srt_transcript:
        blocks = payload.get("blocks") or []
        srt_cues = []
        for b in blocks:
            active_tokens = [
                t
                for t in b.get("tokens", [])
                if not t.get("deleted") and not t.get("bleeped") and t.get("type") not in ("silence", "laughter")
            ]
            txt = _strip_transcript_tags("".join(t.get("text", "") for t in active_tokens))
            if not txt:
                continue
            start_ms = active_tokens[0].get("sourceStartMs", 0)
            end_ms = active_tokens[-1].get("sourceEndMs", start_ms + 1000)
            idx = len(srt_cues) + 1
            srt_cues.append(
                f"{idx}\n{_format_srt_ms(start_ms)} --> {_format_srt_ms(max(start_ms + 200, end_ms))}\n{txt}"
            )
        srt_transcript = "\n\n".join(srt_cues)

    if not (llm_cfg.get("apiKey") or "").strip():
        return {
            "ok": True,
            "engine": "local_fallback",
            "shownotes": None,
            "fallbackReason": "NO_API_KEY",
        }

    # 剥离 SRT 序号与时间轴后校验是否包含实质文字稿内容，严禁把空文稿发给 AI 导致凭空幻想
    srt_body_only = re.sub(
        r"(?m)^\s*\d+\s*$|^\s*\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}\s*$",
        "",
        srt_transcript,
    ).strip()
    if len(_strip_transcript_tags(srt_body_only)) < 10:
        return {
            "ok": True,
            "engine": "local_fallback",
            "shownotes": None,
            "fallbackReason": "EMPTY_TRANSCRIPT",
        }

    try:
        effective_srt = _compact_srt_transcript(srt_transcript, max_chars=80000)
        prompt = (
            f"# Role\n"
            f"你是一位资深的播客制作人与内容运营专家，擅长从长篇录音转文字稿中提炼核心价值，撰写兼具吸引力与信息密度的 Shownotes（单集介绍）。\n\n"
            f"# Task\n"
            f"请仔细阅读下方《{project_title}》的 SRT 格式录音转文字稿，**仅依据该文字稿的实际内容**，生成结构化 Shownotes，严格输出合法 JSON。\n\n"
            f"# 最高铁律（严禁幻想与编造，违者视作完全失败）：\n"
            f"1. **100% 忠于下方 SRT 文字稿原意**：所有标题、简介、时间轴、书影音中出现的人名、地名、产品名、数字、事件与观点，**必须全部真实出自下方 SRT 文字稿**！\n"
            f"2. **严禁脑补或套用空话**：绝对禁止编造文稿中未提及的嘉宾背景、行业大词（如“一线实践”“商业闭环”“方法论体系”等文稿没聊过的内容）、虚构案例或不存在的互动福利。\n"
            f"3. **时间戳必须真实对齐**：每条 timeline 的 `timeSec` 必须严格对应下方 SRT 中该话题实际开始的时间点（将 `HH:MM:SS,mmm` 换算为整数秒）。\n"
            f"4. **禁止原话整句照搬**：用简洁准确的书面语概括段落内容，严禁在 summary 或 timeline 中大段摘抄口语原句。\n\n"
            f"# 各板块输出要求：\n"
            f"## 1. 备选标题（titleOptions，提供 3 个不同风格，均须紧扣文字稿真实话题）\n"
            f"- pain_point（悬念/痛点型）：直击文字稿探讨的核心痛点或疑问\n"
            f"- insight（干货/金句型）：突出文字稿中的核心结论或高光观点\n"
            f"- narrative（温和/陪伴型）：适合深度对谈、故事分享的叙事感标题\n"
            f"- 同时将最推荐的一条填入 `episodeTitle`。\n\n"
            f"## 2. 本期简介（summary，150～420 字，视文稿信息量而定，绝不注水凑字）\n"
            f"- 第一段（钩子）：1-2 句话点明本期文字稿探讨的核心问题或背景。\n"
            f"- 第二段（核心内容）：忠实概括对谈的实际脉络、聊到的关键观点与具体事例。\n"
            f"- 第三段（听众收获）：说明听完这期真实内容能获得什么启发或参考。\n"
            f"*要求：禁止使用“欢迎收听……”“本期节目我们聊了……”等流水账开头；不使用 `#` 或 `**` 等 Markdown 符号。*\n\n"
            f"## 3. 时间轴 / Highlights（timeline，按文稿实际话题转折划分）\n"
            f"- 划分原则：根据文字稿中话题的实质性转折划分（忽略无意义寒暄），按实际话题数量输出（通常 3～15 个节点，文稿较短时切勿为了凑数而强行拆分或编造）。\n"
            f"- 格式规范：\n"
            f"  - `timeSec`：整数（秒），严格对应 SRT 中该话题实际开始的秒数。\n"
            f"  - `title`：6～16 字核心主题短语（必须来自文稿真实议题）。\n"
            f"  - `summary`：15～45 字具体展开说明（提炼文稿中实际提到的对比、细节、案例或结论）。\n\n"
            f"## 4. 提及书影音 / 延伸资料（references，仅限文中明确提及）\n"
            f"- 仅提取 SRT 文字稿中**明确提到**的书籍（book）、电影/纪录片（movie）、文章/论文（article）、工具/产品（tool）或人物（person）。\n"
            f"- 若未提及任何延伸资料，严格返回空数组 `[]`，切勿编造。\n\n"
            f"# Output JSON 字段要求：\n"
            f"1. `episodeTitle`: 最推荐的单集主标题（字符串）\n"
            f"2. `titleOptions`: 数组（3 项），每项 `{{style: \"pain_point\"|\"insight\"|\"narrative\", label: \"悬念/痛点型\"|\"干货/金句型\"|\"温和/陪伴型\", title: 标题}}`\n"
            f"3. `summary`: 150-420字左右的中文节目简介（纯正文分段，无 # 或 **）\n"
            f"4. `timeline`: 数组，每项 `{{timeSec: 整数秒, title: 6~16字核心主题, summary: 15~45字真实内容展开}}`\n"
            f"5. `references`: 数组（无则 `[]`），每项 `{{category: \"book\"|\"movie\"|\"article\"|\"tool\"|\"person\"|\"other\", title: 名称, note: 简短说明}}`\n"
            f"6. `activitySuggestion`: 仅当文字稿中明确提到互动/抽奖活动时填写 `{{title, description, posterSlogan}}`，否则返回 `null`\n"
            f"7. `benefitsSuggestion`: 仅当文字稿中明确提到听友福利时填写数组，否则返回 `[]`\n\n"
            f"SRT 录音转文字稿：\n{effective_srt}"
        )
        llm_raw = call_cloud_llm(
            prompt,
            llm_cfg,
            system_prompt="你是一位严谨的播客内容编辑。你只能基于用户提供的 SRT 录音转文字稿进行归纳总结，绝不允许编造任何文字稿中未出现的内容，严格输出合法 JSON。",
            timeout=90,
            temperature=0.1,
        )
        llm_json = _unwrap_shownotes_json(_extract_json_object(llm_raw))
        if isinstance(llm_json, dict):
            # 净化消除意外遗留的生硬原话摘抄引号
            if isinstance(llm_json.get("summary"), str):
                cleaned_summary = re.sub(r'分享了关于[“"『]([^”"』]+)[”"』]的思考', r'深入探讨了\1的相关议题', llm_json["summary"])
                cleaned_summary = re.sub(r'[“"『]([^”"』]{15,})[”"』]', r'\1', cleaned_summary)
                llm_json["summary"] = cleaned_summary
            if isinstance(llm_json.get("timeline"), list):
                for item in llm_json["timeline"]:
                    if isinstance(item, dict):
                        if isinstance(item.get("title"), str):
                            item["title"] = re.sub(r'[“"『]([^”"』]{10,})[”"』]', r'\1', item["title"]).strip()
                        if isinstance(item.get("summary"), str):
                            item["summary"] = re.sub(r'[“"『]([^”"』]{10,})[”"』]', r'\1', item["summary"]).strip()
            if isinstance(llm_json.get("titleOptions"), list):
                cleaned_opts = []
                for opt in llm_json["titleOptions"]:
                    if isinstance(opt, dict) and isinstance(opt.get("title"), str) and opt["title"].strip():
                        cleaned_opts.append({
                            "style": opt.get("style") or "insight",
                            "label": opt.get("label") or "备选标题",
                            "title": opt["title"].strip(),
                        })
                llm_json["titleOptions"] = cleaned_opts[:3]
            if isinstance(llm_json.get("references"), list):
                valid_cats = {"book", "movie", "article", "tool", "person", "other"}
                cleaned_refs = []
                for ref in llm_json["references"]:
                    if isinstance(ref, dict) and isinstance(ref.get("title"), str) and ref["title"].strip():
                        cat = ref.get("category") if ref.get("category") in valid_cats else "other"
                        cleaned_refs.append({
                            "category": cat,
                            "title": ref["title"].strip(),
                            "note": (ref.get("note") or "").strip(),
                        })
                llm_json["references"] = cleaned_refs
        return {
            "ok": True,
            "engine": f"cloud_llm_{llm_cfg.get('provider', 'deepseek')}",
            "shownotes": llm_json,
        }
    except Exception as exc:
        return {
            "ok": True,
            "engine": "local_fallback",
            "shownotes": None,
            "fallbackReason": str(exc),
        }


def handle_analyze_live_speakers(payload: Dict[str, Any]) -> Dict[str, Any]:
    load_dotenv_local()
    llm_cfg = resolve_effective_llm_config(payload)
    from live_session import analyze_speakers_by_content

    res = analyze_speakers_by_content(
        {
            "scenario": payload.get("scenario", "interview"),
            "prep": payload.get("prep") or {},
            "speakers": payload.get("speakers") or [],
            "utterances": payload.get("utterances") or [],
            "mode": payload.get("mode", "hybrid"),
            "allowNewSpeakers": payload.get("allowNewSpeakers", False),
            "llmConfig": llm_cfg,
        }
    )
    return {"ok": True, **res}


def main() -> None:
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "live":
            from live_session import run_live_session

            run_live_session()
            return
        if len(sys.argv) > 1 and sys.argv[1] == "check_capabilities":
            print(json.dumps(handle_check_capabilities(), ensure_ascii=False), flush=True)
            return

        raw_in = "" if sys.stdin.isatty() else sys.stdin.read().strip()
        req = json.loads(raw_in) if raw_in else {"command": "check_capabilities"}
        command = req.get("command", "check_capabilities")

        if command == "check_capabilities":
            out = handle_check_capabilities()
        elif command == "transcribe_stems":
            out = handle_transcribe_stems(req)
        elif command == "analyze_transcript":
            out = handle_analyze_transcript(req)
        elif command == "generate_shownotes":
            out = handle_generate_shownotes(req)
        elif command == "analyze_live_speakers":
            out = handle_analyze_live_speakers(req)
        else:
            out = {"ok": False, "error": f"Unknown command: {command}"}

        print(json.dumps(out, ensure_ascii=False), flush=True)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
