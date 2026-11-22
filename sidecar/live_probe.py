#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Manual probe script to stream a local WAV file into `podcraft_ai.py live` using real credentials."""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import wave

import numpy as np


def load_wav_16k_int16(path: str) -> np.ndarray:
    with wave.open(path, "rb") as wf:
        sr = wf.getframerate()
        ch = wf.getnchannels()
        sw = wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())
    if sw != 2:
        raise RuntimeError(f"Unsupported sample width: {sw}")
    arr = np.frombuffer(raw, dtype="<i2")
    if ch > 1:
        arr = arr.reshape(-1, ch)[:, 0]
    if sr != 16000:
        n_out = max(1, int(round(len(arr) * 16000.0 / float(sr))))
        xp = np.linspace(0.0, 1.0, len(arr), endpoint=False)
        x = np.linspace(0.0, 1.0, n_out, endpoint=False)
        arr = np.interp(x, xp, arr.astype(np.float32)).astype("<i2")
    return arr


def main() -> None:
    parser = argparse.ArgumentParser(description="Live sidecar probe with real Volcengine/LLM credentials")
    parser.add_argument("wav", help="Path to input WAV file")
    parser.add_argument("--fast", action="store_true", help="Send chunks faster (20ms interval instead of 100ms)")
    parser.add_argument("--engine", choices=["auto", "volcengine", "local"], default="auto", help="ASR engine mode")
    args = parser.parse_args()

    sidecar_dir = os.path.dirname(os.path.abspath(__file__))
    script = os.path.join(sidecar_dir, "podcraft_ai.py")
    samples = load_wav_16k_int16(args.wav)

    with tempfile.TemporaryDirectory(prefix="tapwave_probe_") as out_dir:
        proc = subprocess.Popen(
            [sys.executable, "-u", script, "live"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert proc.stdin is not None and proc.stdout is not None

        def _drain_stderr() -> None:
            assert proc.stderr is not None
            for ln in proc.stderr:
                sys.stderr.write("[stderr] " + ln)

        def _read_stdout() -> None:
            assert proc.stdout is not None
            for ln in proc.stdout:
                print(ln.strip(), flush=True)

        t_err = threading.Thread(target=_drain_stderr, daemon=True)
        t_out = threading.Thread(target=_read_stdout, daemon=True)
        t_err.start()
        t_out.start()

        start_cmd = {
            "type": "start",
            "sessionId": "probe_1",
            "outputDir": out_dir,
            "asrEngine": args.engine,
            "scenario": "interview",
            "title": "Probe 测试",
            "prep": {
                "topic": "语音识别测试",
                "goals": "验证流式 ASR 与 LiveCopilot",
                "counterpartName": "嘉宾",
                "counterpartBackground": "",
                "outline": [{"id": "o1", "text": "核心内容"}],
            },
            "speakers": [
                {"id": "host", "name": "我", "role": "self"},
                {"id": "guest", "name": "嘉宾", "role": "counterpart"},
            ],
            "firstSpeakerId": "guest",
            "asrConfig": {},
            "llmConfig": {},
            "hotwords": [],
        }
        proc.stdin.write(json.dumps(start_cmd, ensure_ascii=False) + "\n")
        proc.stdin.flush()

        chunk_samples = 1600  # 100ms
        interval = 0.02 if args.fast else 0.1
        seq = 0
        for i in range(0, len(samples), chunk_samples):
            chunk = samples[i : i + chunk_samples]
            b64 = base64.b64encode(chunk.tobytes()).decode("ascii")
            proc.stdin.write(json.dumps({"type": "audio", "pcm": b64, "seq": seq}) + "\n")
            proc.stdin.flush()
            seq += 1
            time.sleep(interval)

        # Pad 1.5s of silence so VAD triggers definite
        silence_b64 = base64.b64encode(np.zeros(chunk_samples, dtype="<i2").tobytes()).decode("ascii")
        for _ in range(15):
            proc.stdin.write(json.dumps({"type": "audio", "pcm": silence_b64, "seq": seq}) + "\n")
            proc.stdin.flush()
            seq += 1
            time.sleep(0.05)

        proc.stdin.write(json.dumps({"type": "request_insight"}) + "\n")
        proc.stdin.flush()
        time.sleep(1.0)
        proc.stdin.write(json.dumps({"type": "stop"}) + "\n")
        proc.stdin.flush()

        proc.wait(timeout=40)
        t_out.join(timeout=2)
        print("Output files:", os.listdir(out_dir))


if __name__ == "__main__":
    main()
