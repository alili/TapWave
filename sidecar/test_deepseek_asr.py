#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unit & local mock HTTP server tests for DeepSeek ASR integration in podcraft_ai.py."""

import email
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import json
import os
import sys
import tempfile
import threading
import unittest
import wave

import numpy as np

SIDECAR_DIR = os.path.dirname(os.path.abspath(__file__))
if SIDECAR_DIR not in sys.path:
    sys.path.insert(0, SIDECAR_DIR)

import podcraft_ai  # noqa: E402


class DeepSeekAsrTests(unittest.TestCase):
    def test_url_normalization(self) -> None:
        self.assertEqual(
            podcraft_ai.build_deepseek_asr_url(""),
            "https://api.deepseek.com/v1/tools/asr",
        )
        self.assertEqual(
            podcraft_ai.build_deepseek_asr_url("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/tools/asr",
        )
        self.assertEqual(
            podcraft_ai.build_deepseek_asr_url("https://api.deepseek.com/"),
            "https://api.deepseek.com/v1/tools/asr",
        )
        self.assertEqual(
            podcraft_ai.build_deepseek_asr_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/tools/asr",
        )
        self.assertEqual(
            podcraft_ai.build_deepseek_asr_url("https://api.deepseek.com/v1/tools/asr"),
            "https://api.deepseek.com/v1/tools/asr",
        )
        self.assertEqual(
            podcraft_ai.build_deepseek_asr_url(
                "http://127.0.0.1:8080/v1/audio/transcriptions"
            ),
            "http://127.0.0.1:8080/v1/audio/transcriptions",
        )

    def test_wav_encoding_and_multipart(self) -> None:
        sr = 16000
        t = np.linspace(0, 1.5, int(sr * 1.5), endpoint=False, dtype=np.float32)
        samples = 0.5 * np.sin(2 * np.pi * 440.0 * t)
        wav_bytes = podcraft_ai.encode_pcm16_wav_bytes(samples, sample_rate=sr)
        self.assertLess(len(wav_bytes), podcraft_ai.DEEPSEEK_ASR_MAX_BYTES)

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            self.assertEqual(wf.getnchannels(), 1)
            self.assertEqual(wf.getsampwidth(), 2)
            self.assertEqual(wf.getframerate(), sr)
            self.assertEqual(wf.getnframes(), int(sr * 1.5))

        body, content_type = podcraft_ai.build_multipart_wav_body(wav_bytes, "chunk.wav")
        self.assertIn("multipart/form-data; boundary=", content_type)
        self.assertIn(b'name="file"; filename="chunk.wav"', body)
        self.assertIn(b"Content-Type: audio/wav", body)
        self.assertIn(wav_bytes, body)

    def test_coalesce_and_cap_segments_strictly_under_55s(self) -> None:
        sr = 16000
        # 135s audio with a pronounced quiet valley around 67.5s
        n = 135 * sr
        t = np.arange(n, dtype=np.float32) / sr
        samples = 0.4 * np.sin(2 * np.pi * 220.0 * t)
        samples[int(67.2 * sr) : int(67.8 * sr)] *= 0.01

        segs = podcraft_ai.coalesce_vad_segments_for_cloud_asr(
            [(0, n)], samples, hard_max_sec=55.0
        )
        self.assertGreaterEqual(len(segs), 3)
        for s, e in segs:
            self.assertLessEqual((e - s) / sr, 55.0)
            self.assertGreater(e, s)

        # Short segments separated by 0.3s gap should coalesce cleanly
        short_segs = [(1 * sr, 3 * sr), (int(3.3 * sr), 6 * sr), (20 * sr, 23 * sr)]
        coalesced = podcraft_ai.coalesce_vad_segments_for_cloud_asr(
            short_segs, samples, max_gap_sec=0.75, target_chunk_sec=24.0, hard_max_sec=55.0
        )
        self.assertEqual(len(coalesced), 2)
        self.assertEqual(coalesced[0], (1 * sr, 6 * sr))
        self.assertEqual(coalesced[1], (20 * sr, 23 * sr))

    def test_end_to_end_mock_deepseek_server_transcribe(self) -> None:
        captured: list[dict] = []

        class MockHandler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args) -> None:  # noqa: A002
                pass

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(length)
                ctype = self.headers.get("Content-Type", "")
                auth = self.headers.get("Authorization", "")

                # Parse multipart form-data with stdlib email parser
                msg = email.message_from_bytes(
                    f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
                    + raw_body
                )
                part_names = []
                wav_frames = 0
                wav_rate = 0
                wav_channels = 0
                for part in msg.walk():
                    disp = part.get("Content-Disposition", "")
                    if "form-data" not in disp:
                        continue
                    name = part.get_param("name", header="content-disposition")
                    part_names.append(name)
                    if name == "file":
                        payload = part.get_payload(decode=True) or b""
                        with wave.open(io.BytesIO(payload), "rb") as wf:
                            wav_rate = wf.getframerate()
                            wav_channels = wf.getnchannels()
                            wav_frames = wf.getnframes()

                captured.append(
                    {
                        "path": self.path,
                        "auth": auth,
                        "parts": part_names,
                        "wav_frames": wav_frames,
                        "wav_rate": wav_rate,
                        "wav_channels": wav_channels,
                    }
                )
                resp_bytes = json.dumps(
                    {
                        "request_id": "req_mock_001",
                        "text": "大家好，欢迎来到 “PodCraft Studio” 第 12 期节目！",
                        "duration_ms": 2400,
                    },
                    ensure_ascii=False,
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(resp_bytes)))
                self.end_headers()
                self.wfile.write(resp_bytes)

        server = HTTPServer(("127.0.0.1", 0), MockHandler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        tmp_wav = None
        try:
            # 0.6s silence + 3.2s speech-like modulated formant wave + 0.5s silence
            sr = 16000
            silence1 = np.zeros(int(0.6 * sr), dtype=np.float32)
            t = np.linspace(0, 3.2, int(3.2 * sr), endpoint=False, dtype=np.float32)
            env = 0.55 + 0.40 * np.sin(2 * np.pi * 4.5 * t)
            carrier = (
                0.55 * np.sin(2 * np.pi * 165.0 * t)
                + 0.30 * np.sin(2 * np.pi * 495.0 * t)
                + 0.15 * np.sin(2 * np.pi * 1150.0 * t)
            )
            speech = (0.45 * env * carrier).astype(np.float32)
            silence2 = np.zeros(int(0.5 * sr), dtype=np.float32)
            full = np.concatenate([silence1, speech, silence2])

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
                tmp_wav = tf.name
            with wave.open(tmp_wav, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sr)
                wf.writeframes((full * 32767.0).astype("<i2").tobytes())

            res = podcraft_ai.handle_transcribe_stems(
                {
                    "recordingMode": "same_room_sync",
                    "glossary": [],
                    "asrConfig": {
                        "provider": "deepseek",
                        "apiKey": "sk-mock-deepseek-123",
                        "baseUrl": f"http://127.0.0.1:{port}",
                        "model": "",
                        "fallbackToLocal": False,
                    },
                    "tracks": [
                        {
                            "id": "sp_1",
                            "name": "主播",
                            "role": "host",
                            "filePath": tmp_wav,
                            "syncOffsetMs": 0,
                            "isRef": False,
                        }
                    ],
                }
            )
            self.assertTrue(res["ok"])
            self.assertEqual(res["engine"], "deepseek_asr")
            self.assertEqual(len(captured), 1)
            self.assertEqual(captured[0]["path"], "/v1/tools/asr")
            self.assertEqual(captured[0]["auth"], "Bearer sk-mock-deepseek-123")
            self.assertEqual(captured[0]["parts"], ["file"])
            self.assertEqual(captured[0]["wav_rate"], 16000)
            self.assertEqual(captured[0]["wav_channels"], 1)
            self.assertGreater(captured[0]["wav_frames"], 16000)

            tokens = res["tracks"]["sp_1"]["tokens"]
            self.assertGreater(len(tokens), 8)
            joined = "".join(tok["text"] for tok in tokens)
            self.assertIn("大家好，", joined)
            self.assertIn("PodCraft ", joined)
            self.assertIn("Studio", joined)
            self.assertIn("12", joined)
            self.assertIn("节目！", joined)

            prev_start = -1
            for tok in tokens:
                self.assertGreater(tok["endMs"], tok["startMs"])
                self.assertGreaterEqual(tok["startMs"], prev_start)
                prev_start = tok["startMs"]
        finally:
            server.shutdown()
            server.server_close()
            if tmp_wav and os.path.exists(tmp_wav):
                os.unlink(tmp_wav)

    def test_auth_error_and_missing_key_without_fallback(self) -> None:
        class ErrHandler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args) -> None:  # noqa: A002
                pass

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                _ = self.rfile.read(length)
                err_body = json.dumps({"error": {"message": "Invalid API key"}}).encode(
                    "utf-8"
                )
                self.send_response(401)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(err_body)))
                self.end_headers()
                self.wfile.write(err_body)

        server = HTTPServer(("127.0.0.1", 0), ErrHandler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        tmp_wav = None
        old_env = os.environ.pop("DEEPSEEK_API_KEY", None)
        try:
            sr = 16000
            t = np.linspace(0, 1.5, int(1.5 * sr), endpoint=False, dtype=np.float32)
            speech = (0.45 * np.sin(2 * np.pi * 240.0 * t)).astype(np.float32)
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
                tmp_wav = tf.name
            with wave.open(tmp_wav, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sr)
                wf.writeframes((speech * 32767.0).astype("<i2").tobytes())

            missing_res = podcraft_ai.handle_transcribe_stems(
                {
                    "recordingMode": "same_room_sync",
                    "glossary": [],
                    "asrConfig": {
                        "provider": "deepseek",
                        "apiKey": "",
                        "baseUrl": f"http://127.0.0.1:{port}",
                        "fallbackToLocal": False,
                    },
                    "tracks": [
                        {
                            "id": "sp_1",
                            "name": "主播",
                            "role": "host",
                            "filePath": tmp_wav,
                            "isRef": False,
                        }
                    ],
                }
            )
            self.assertFalse(missing_res["ok"])
            self.assertIn("Key", missing_res["error"])

            auth_res = podcraft_ai.handle_transcribe_stems(
                {
                    "recordingMode": "same_room_sync",
                    "glossary": [],
                    "asrConfig": {
                        "provider": "deepseek",
                        "apiKey": "sk-bad-key",
                        "baseUrl": f"http://127.0.0.1:{port}",
                        "fallbackToLocal": False,
                    },
                    "tracks": [
                        {
                            "id": "sp_1",
                            "name": "主播",
                            "role": "host",
                            "filePath": tmp_wav,
                            "isRef": False,
                        }
                    ],
                }
            )
            self.assertFalse(auth_res["ok"])
            self.assertIn("401", auth_res["error"])
        finally:
            if old_env is not None:
                os.environ["DEEPSEEK_API_KEY"] = old_env
            server.shutdown()
            server.server_close()
            if tmp_wav and os.path.exists(tmp_wav):
                os.unlink(tmp_wav)


if __name__ == "__main__":
    unittest.main()
