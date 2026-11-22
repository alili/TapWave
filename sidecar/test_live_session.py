#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unit & end-to-end tests for live_ws and live_session."""

from __future__ import annotations

import base64
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import json
import os
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import wave

import numpy as np

SIDECAR_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SIDECAR_DIR)
if SIDECAR_DIR not in sys.path:
    sys.path.insert(0, SIDECAR_DIR)

import live_ws  # noqa: E402
import live_session  # noqa: E402


def _read_wav_16k_int16(path: str) -> np.ndarray:
    with wave.open(path, "rb") as wf:
        sr = wf.getframerate()
        ch = wf.getnchannels()
        sw = wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())
    if sw != 2:
        raise ValueError(f"Unsupported sample width {sw}")
    arr = np.frombuffer(raw, dtype="<i2")
    if ch > 1:
        arr = arr.reshape(-1, ch)[:, 0]
    if sr != 16000:
        n_out = max(1, int(round(len(arr) * 16000.0 / float(sr))))
        xp = np.linspace(0.0, 1.0, len(arr), endpoint=False)
        x = np.linspace(0.0, 1.0, n_out, endpoint=False)
        arr = np.interp(x, xp, arr.astype(np.float32)).astype("<i2")
    return arr


def _pack_server_ws_frame(opcode: int, payload: bytes) -> bytes:
    length = len(payload)
    hdr = bytearray([0x80 | (opcode & 0x0F)])
    if length < 126:
        hdr.append(length)
    elif length < 65536:
        hdr.append(126)
        hdr.extend(struct.pack(">H", length))
    else:
        hdr.append(127)
        hdr.extend(struct.pack(">Q", length))
    return bytes(hdr) + payload


def _read_client_ws_frame(sock) -> tuple[int, bytes]:
    def exact(n: int) -> bytes:
        buf = bytearray()
        while len(buf) < n:
            c = sock.recv(n - len(buf))
            if not c:
                raise EOFError()
            buf.extend(c)
        return bytes(buf)

    b1, b2 = exact(2)
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    length = b2 & 0x7F
    if length == 126:
        (length,) = struct.unpack(">H", exact(2))
    elif length == 127:
        (length,) = struct.unpack(">Q", exact(8))
    mask = exact(4) if masked else b""
    payload = exact(length) if length > 0 else b""
    if masked and payload:
        payload = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
    return opcode, payload


def _build_volc_server_response(payload_obj: dict, is_last: bool = False, with_seq: bool = False) -> bytes:
    raw = json.dumps(payload_obj, ensure_ascii=False).encode("utf-8")
    gz = gzip.compress(raw)
    flags = (live_ws.FLAG_LAST_PACKAGE if is_last else 0) | (live_ws.FLAG_HAS_SEQUENCE if with_seq else 0)
    b0 = 0x11
    b1 = (live_ws.MSG_FULL_SERVER_RESPONSE << 4) | flags
    b2 = (live_ws.SER_JSON << 4) | live_ws.COMP_GZIP
    head = bytes([b0, b1, b2, 0])
    if with_seq:
        head += struct.pack(">i", 1)
    return head + struct.pack(">I", len(gz)) + gz


def _build_volc_error_frame(code: int, message: str) -> bytes:
    msg_b = message.encode("utf-8")
    head = bytes([0x11, (live_ws.MSG_ERROR_RESPONSE << 4) | 0, 0, 0])
    return head + struct.pack(">II", code, len(msg_b)) + msg_b


class LiveWsCodecTests(unittest.TestCase):
    def test_volc_frame_roundtrip_and_error(self) -> None:
        req = {"user": {"uid": "u1"}, "request": {"enable_itn": True}}
        frame = live_ws.build_full_client_request(req)
        self.assertEqual(frame[0], 0x11)
        self.assertEqual((frame[1] >> 4) & 0x0F, live_ws.MSG_FULL_CLIENT_REQUEST)
        (plen,) = struct.unpack(">I", frame[4:8])
        decoded = json.loads(gzip.decompress(frame[8 : 8 + plen]).decode("utf-8"))
        self.assertEqual(decoded, req)

        srv_bytes = _build_volc_server_response({"result": {"text": "你好"}}, is_last=True, with_seq=True)
        parsed = live_ws.parse_volc_frame(srv_bytes)
        self.assertEqual(parsed["kind"], "response")
        self.assertTrue(parsed["isLast"])
        self.assertEqual(parsed["seq"], 1)
        self.assertEqual(parsed["payload"]["result"]["text"], "你好")

        err_bytes = _build_volc_error_frame(45000001, "invalid param")
        err_parsed = live_ws.parse_volc_frame(err_bytes)
        self.assertEqual(err_parsed["kind"], "error")
        self.assertEqual(err_parsed["code"], 45000001)
        self.assertEqual(err_parsed["message"], "invalid param")

    def test_simple_websocket_handshake_ping_and_binary(self) -> None:
        captured_headers: dict[str, str] = {}

        class Handler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                raw = bytearray()
                while b"\r\n\r\n" not in raw:
                    raw.extend(self.request.recv(4096))
                lines = bytes(raw).decode("utf-8").split("\r\n")
                for ln in lines[1:]:
                    if ":" in ln:
                        k, v = ln.split(":", 1)
                        captured_headers[k.strip().lower()] = v.strip()
                ws_key = captured_headers["sec-websocket-key"]
                accept = base64.b64encode(
                    hashlib.sha1((ws_key + live_ws.WS_MAGIC_GUID).encode("ascii")).digest()
                ).decode("ascii")
                resp = (
                    "HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
                )
                self.request.sendall(resp.encode("ascii"))
                op, payload = _read_client_ws_frame(self.request)
                assert op == 0x2
                self.request.sendall(_pack_server_ws_frame(0x9, b"ping"))
                pong_op, pong_payload = _read_client_ws_frame(self.request)
                assert pong_op == 0xA
                assert pong_payload == b"ping"
                self.request.sendall(_pack_server_ws_frame(0x2, payload + b"!"))
                self.request.sendall(_pack_server_ws_frame(0x8, struct.pack(">H", 1000)))

        class ReuseServer(socketserver.ThreadingTCPServer):
            allow_reuse_address = True

        srv = ReuseServer(("127.0.0.1", 0), Handler)
        port = srv.server_address[1]
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            ws = live_ws.SimpleWebSocket.connect(
                f"ws://127.0.0.1:{port}/api/v3/sauc/bigmodel_async",
                headers={"X-Api-Key": "test-key"},
                timeout=3.0,
            )
            ws.send_binary(b"hello")
            op, data = ws.recv()
            self.assertEqual(op, 0x2)
            self.assertEqual(data, b"hello!")
            with self.assertRaises(live_ws.WsClosed):
                ws.recv()
            self.assertEqual(captured_headers.get("x-api-key"), "test-key")
        finally:
            srv.shutdown()
            srv.server_close()


class LiveSessionLogicTests(unittest.TestCase):
    def test_utterance_tracker_partial_and_definite_dedup(self) -> None:
        tr = live_session.UtteranceTracker(offset_ms=5000)
        finals, partial = tr.process_payload(
            {
                "result": {
                    "utterances": [
                        {"text": "你好", "start_time": 100, "end_time": 600, "definite": False}
                    ]
                }
            }
        )
        self.assertEqual(finals, [])
        self.assertEqual(partial["text"], "你好")
        self.assertEqual(partial["startMs"], 5100)

        finals2, partial2 = tr.process_payload(
            {
                "result": {
                    "utterances": [
                        {
                            "text": "你好世界。",
                            "start_time": 100,
                            "end_time": 1200,
                            "definite": True,
                            "speaker_id": "2",
                        }
                    ]
                }
            }
        )
        self.assertEqual(len(finals2), 1)
        self.assertEqual(finals2[0]["startMs"], 5100)
        self.assertEqual(finals2[0]["endMs"], 6200)
        self.assertEqual(finals2[0]["cloudSpeakerId"], "2")
        self.assertIsNone(partial2)

        # Duplicate definite is ignored
        finals3, _ = tr.process_payload(
            {
                "result": {
                    "utterances": [
                        {"text": "你好世界。", "start_time": 100, "end_time": 1200, "definite": True}
                    ]
                }
            }
        )
        self.assertEqual(finals3, [])

    def test_speaker_resolver_voiceprint_and_manual_assign(self) -> None:
        wav1 = os.path.join(
            ROOT_DIR,
            "models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/zh.wav",
        )
        wav2 = os.path.join(
            ROOT_DIR,
            "models/sherpa-onnx-paraformer-zh-small-2024-03-09/test_wavs/1.wav",
        )
        self.assertTrue(os.path.isfile(wav1))
        self.assertTrue(os.path.isfile(wav2))

        a1 = _read_wav_16k_int16(wav1)
        a2 = _read_wav_16k_int16(wav2)
        combined = np.concatenate([a1, a2])

        speakers = [
            {"id": "host", "name": "主持人", "role": "self"},
            {"id": "guest", "name": "嘉宾", "role": "counterpart"},
        ]
        res = live_session.SpeakerResolver(speakers=speakers, first_speaker_id="host")
        res.append_audio(combined)

        dur1_ms = int(len(a1) * 1000 / 16000)
        dur2_ms = int(len(a2) * 1000 / 16000)

        s1, lbl1, src1 = res.resolve("u_1", 0, min(dur1_ms, 2500))
        s2, lbl2, src2 = res.resolve("u_2", dur1_ms, dur1_ms + min(dur2_ms, 2500))
        self.assertEqual(src1, "voiceprint")
        self.assertEqual(src2, "voiceprint")
        self.assertEqual(s1, "host")
        self.assertNotEqual(lbl1, lbl2)
        self.assertEqual(s2, "guest")

        # Reassign u_2 to host with apply_to_label=True
        upd = res.assign("u_2", "host", apply_to_label=True)
        self.assertEqual(upd["speakerId"], "host")
        # Another segment from wav2 should now follow the updated label_map
        s3, lbl3, _ = res.resolve("u_3", dur1_ms + 100, dur1_ms + min(dur2_ms, 2600))
        self.assertEqual(lbl3, lbl2)
        self.assertEqual(s3, "host")

    def test_should_trigger_and_normalize_insight(self) -> None:
        self.assertFalse(live_session.should_trigger_insight(10.0, 0.0, 0, 0))
        self.assertTrue(live_session.should_trigger_insight(20.0, 0.0, 130, 0))
        self.assertTrue(live_session.should_trigger_insight(10.0, 0.0, 65, 65))
        self.assertTrue(live_session.should_trigger_insight(61.0, 0.0, 20, 0))
        self.assertTrue(live_session.should_trigger_insight(2.0, 0.0, 0, 0, manual=True))

        raw = {
            "profile": {
                "background": [{"text": "a" * 120, "evidenceMs": 1000}],
                "stories": [{"title": "创业故事", "gist": "曾连续失败两次", "evidenceMs": 2000}],
                "viewpoints": [{"claim": "产品优先", "support": "用户留存更重要", "evidenceMs": 3000}],
                "sales": {"painPoints": ["效率低"]},
            },
            "questions": [
                {"type": "deepen", "text": "那次失败后你们怎么调整？", "why": "挖转折点", "relatedTo": "创业故事"},
                {"type": "follow_up", "text": "跳过这个问题", "why": "测试过滤", "relatedTo": ""},
                {"type": "handle_objection", "text": "预算怎么看？", "why": "销售类型", "relatedTo": ""},
            ],
            "turnSummaries": [
                {"speakerId": "host", "startMs": 100, "summary": "旧摘要应过滤"},
                {"speakerId": "guest", "startMs": 5000, "summary": "分享早期创业教训"},
            ],
            "keyPoints": ["要点1"],
            "outlineCoverage": [{"id": "o1", "status": "covered", "note": "已聊到"}],
        }
        norm = live_session.normalize_live_insight(
            raw,
            scenario="interview",
            dismissed_texts=["跳过这个问题"],
            last_summarized_ms=1000,
            valid_speaker_ids=["host", "guest"],
            outline_items=[{"id": "o1", "text": "创业经历"}],
        )
        self.assertNotIn("sales", norm["profile"])
        self.assertEqual(len(norm["profile"]["background"][0]["text"]), 80)
        self.assertEqual(len(norm["questions"]), 2)
        self.assertEqual(norm["questions"][1]["type"], "follow_up")
        self.assertEqual(len(norm["turnSummaries"]), 1)
        self.assertEqual(norm["turnSummaries"][0]["startMs"], 5000)

    def test_end_to_end_live_session_with_mock_ws_and_llm(self) -> None:
        # 1. Mock LLM HTTP server
        class MockLlmHandler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args) -> None:  # noqa: A002
                pass

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                user_msg = body["messages"][-1]["content"]
                if "最终会议总结" in user_msg:
                    content = json.dumps(
                        {
                            "overview": "本次采访围绕实时语音副驾展开。",
                            "keyTakeaways": ["低延迟很关键"],
                            "nextSteps": ["补充多语言测试"],
                        },
                        ensure_ascii=False,
                    )
                else:
                    content = json.dumps(
                        {
                            "profile": {
                                "background": [{"text": "播客创作者", "evidenceMs": 500}],
                                "stories": [],
                                "viewpoints": [{"claim": "实时提示有用", "support": "减少冷场", "evidenceMs": 800}],
                            },
                            "questions": [
                                {"type": "deepen", "text": "最常遇到什么冷场？", "why": "了解痛点", "relatedTo": "观点"}
                            ],
                            "turnSummaries": [{"speakerId": "guest", "startMs": 100, "summary": "介绍了录制痛点"}],
                            "keyPoints": ["实时提问能减少冷场"],
                            "outlineCoverage": [{"id": "o1", "status": "covered", "note": "已提及"}],
                        },
                        ensure_ascii=False,
                    )
                resp_bytes = json.dumps({"choices": [{"message": {"content": content}}]}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(resp_bytes)))
                self.end_headers()
                self.wfile.write(resp_bytes)

        llm_srv = HTTPServer(("127.0.0.1", 0), MockLlmHandler)
        llm_port = llm_srv.server_address[1]
        threading.Thread(target=llm_srv.serve_forever, daemon=True).start()

        # 2. Mock Volcengine WS server
        class MockWsHandler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                raw = bytearray()
                while b"\r\n\r\n" not in raw:
                    raw.extend(self.request.recv(4096))
                hdrs = {}
                for ln in bytes(raw).decode("utf-8").split("\r\n")[1:]:
                    if ":" in ln:
                        k, v = ln.split(":", 1)
                        hdrs[k.strip().lower()] = v.strip()
                accept = base64.b64encode(
                    hashlib.sha1((hdrs["sec-websocket-key"] + live_ws.WS_MAGIC_GUID).encode("ascii")).digest()
                ).decode("ascii")
                self.request.sendall(
                    (
                        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
                    ).encode("ascii")
                )
                sent_final = False
                while True:
                    try:
                        op, payload = _read_client_ws_frame(self.request)
                    except EOFError:
                        break
                    if op == 0x8:
                        break
                    if len(payload) >= 4:
                        msg_type = (payload[1] >> 4) & 0x0F
                        flags = payload[1] & 0x0F
                        if msg_type == live_ws.MSG_AUDIO_ONLY_REQUEST and not sent_final:
                            sent_final = True
                            srv_frame = _build_volc_server_response(
                                {
                                    "result": {
                                        "utterances": [
                                            {
                                                "text": "我们平时采访经常担心聊偏或者冷场。",
                                                "start_time": 100,
                                                "end_time": 1800,
                                                "definite": True,
                                                "speaker_id": "1",
                                            }
                                        ]
                                    }
                                },
                                is_last=False,
                            )
                            self.request.sendall(_pack_server_ws_frame(0x2, srv_frame))
                        if flags & live_ws.FLAG_LAST_PACKAGE:
                            last_frame = _build_volc_server_response({"result": {}}, is_last=True)
                            self.request.sendall(_pack_server_ws_frame(0x2, last_frame))
                            break

        class ReuseWsServer(socketserver.ThreadingTCPServer):
            allow_reuse_address = True

        ws_srv = ReuseWsServer(("127.0.0.1", 0), MockWsHandler)
        ws_port = ws_srv.server_address[1]
        threading.Thread(target=ws_srv.serve_forever, daemon=True).start()

        with tempfile.TemporaryDirectory() as tmpdir:
            env = dict(os.environ)
            env["TAPWAVE_LIVE_WS_URL"] = f"ws://127.0.0.1:{ws_port}/api/v3/sauc/bigmodel_async"
            script = os.path.join(SIDECAR_DIR, "podcraft_ai.py")
            proc = subprocess.Popen(
                [sys.executable, "-u", script, "live"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            assert proc.stdin is not None and proc.stdout is not None

            start_cmd = {
                "type": "start",
                "sessionId": "test_e2e",
                "outputDir": tmpdir,
                "asrEngine": "volcengine",
                "scenario": "interview",
                "title": "端到端测试",
                "prep": {
                    "topic": "播客采访",
                    "goals": "验证实时流程",
                    "counterpartName": "嘉宾",
                    "counterpartBackground": "",
                    "outline": [{"id": "o1", "text": "采访痛点"}],
                },
                "speakers": [
                    {"id": "host", "name": "我", "role": "self"},
                    {"id": "guest", "name": "嘉宾", "role": "counterpart"},
                ],
                "firstSpeakerId": "guest",
                "asrConfig": {"volcApiKey": "dummy-key"},
                "llmConfig": {
                    "provider": "openai",
                    "apiKey": "dummy-llm",
                    "baseUrl": f"http://127.0.0.1:{llm_port}/v1",
                    "model": "mock-model",
                },
                "hotwords": [],
            }
            proc.stdin.write(json.dumps(start_cmd) + "\n")
            proc.stdin.flush()

            pcm_b64 = base64.b64encode(np.zeros(1600, dtype="<i2").tobytes()).decode("ascii")
            for seq in range(3):
                proc.stdin.write(json.dumps({"type": "audio", "pcm": pcm_b64, "seq": seq}) + "\n")
                proc.stdin.flush()
                time.sleep(0.05)

            time.sleep(0.3)
            proc.stdin.write(json.dumps({"type": "request_insight"}) + "\n")
            proc.stdin.flush()
            time.sleep(0.4)
            proc.stdin.write(json.dumps({"type": "stop"}) + "\n")
            proc.stdin.flush()

            out_lines, stderr_txt = proc.communicate(timeout=15)
            events = [json.loads(ln) for ln in out_lines.splitlines() if ln.strip()]
            types = [e.get("type") for e in events]

            self.assertEqual(proc.returncode, 0, msg=stderr_txt)
            self.assertIn("ready", types)
            self.assertIn("final", types)
            self.assertIn("insight_request", types)
            self.assertIn("insight", types)
            self.assertLess(types.index("insight_request"), types.index("insight"))
            self.assertIn("final_summary", types)
            self.assertEqual(types[-1], "stopped")

            self.assertTrue(os.path.isfile(os.path.join(tmpdir, "recording.wav")))
            self.assertTrue(os.path.isfile(os.path.join(tmpdir, "session.json")))

        llm_srv.shutdown()
        llm_srv.server_close()
        ws_srv.shutdown()
        ws_srv.server_close()

    def test_local_streaming_asr_transcribes_zh_wav(self) -> None:
        wav_path = os.path.join(
            ROOT_DIR,
            "models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/zh.wav",
        )
        if not os.path.isfile(wav_path) or not os.path.isfile(
            os.path.join(ROOT_DIR, "models/silero_vad.onnx")
        ):
            self.skipTest("Local ASR models not present")

        samples = _read_wav_16k_int16(wav_path)
        finals: list[dict] = []
        errors: list[tuple[str, bool]] = []
        statuses: list[str] = []

        asr = live_session.LocalStreamingAsr(
            asr_config={},
            hotwords=[],
            on_status=lambda st, _m: statuses.append(st),
            on_partial=lambda _p: None,
            on_final=lambda f: finals.append(f),
            on_error=lambda m, fatal: errors.append((m, fatal)),
            get_session_ms=lambda: int(len(samples) * 1000 // 16000),
        )
        asr.start()
        for idx in range(0, len(samples), 1600):
            asr.push_audio(samples[idx : idx + 1600].tobytes())
        # Pad 1.5s silence so VAD closes final segment
        silence = np.zeros(1600, dtype="<i2").tobytes()
        for _ in range(15):
            asr.push_audio(silence)
        asr.stop(timeout_sec=10.0)

        self.assertEqual(errors, [])
        self.assertIn("connected", statuses)
        self.assertGreaterEqual(len(finals), 1)
        joined = "".join(f["text"] for f in finals)
        self.assertTrue(any("\u4e00" <= ch <= "\u9fff" for ch in joined), msg=f"Got: {joined}")
        self.assertLess(finals[0]["startMs"], finals[0]["endMs"])

    def test_auto_mode_falls_back_to_local_on_403(self) -> None:
        wav_path = os.path.join(
            ROOT_DIR,
            "models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/zh.wav",
        )
        if not os.path.isfile(wav_path) or not os.path.isfile(
            os.path.join(ROOT_DIR, "models/silero_vad.onnx")
        ):
            self.skipTest("Local ASR models not present")

        class Reject403Handler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                raw = bytearray()
                while b"\r\n\r\n" not in raw:
                    c = self.request.recv(4096)
                    if not c:
                        break
                    raw.extend(c)
                body = b'{"error":"requested resource not granted"}'
                resp = (
                    b"HTTP/1.1 403 Forbidden\r\n"
                    b"Content-Type: application/json\r\n"
                    + f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
                    + body
                )
                self.request.sendall(resp)

        class Reuse403Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True

        srv = Reuse403Server(("127.0.0.1", 0), Reject403Handler)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()

        samples = _read_wav_16k_int16(wav_path)
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                env = dict(os.environ)
                env["TAPWAVE_LIVE_WS_URL"] = f"ws://127.0.0.1:{port}/api/v3/sauc/bigmodel_async"
                script = os.path.join(SIDECAR_DIR, "podcraft_ai.py")
                proc = subprocess.Popen(
                    [sys.executable, "-u", script, "live"],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    env=env,
                )
                assert proc.stdin is not None
                start_cmd = {
                    "type": "start",
                    "sessionId": "test_403_fallback",
                    "outputDir": tmpdir,
                    "asrEngine": "auto",
                    "scenario": "interview",
                    "title": "403 回退测试",
                    "prep": {},
                    "speakers": [
                        {"id": "host", "name": "我", "role": "self"},
                        {"id": "guest", "name": "嘉宾", "role": "counterpart"},
                    ],
                    "firstSpeakerId": "guest",
                    "asrConfig": {"volcApiKey": "dummy-key"},
                    "llmConfig": {"provider": "local_only"},
                    "hotwords": [],
                }
                proc.stdin.write(json.dumps(start_cmd) + "\n")
                proc.stdin.flush()

                for idx in range(0, len(samples), 1600):
                    b64 = base64.b64encode(samples[idx : idx + 1600].tobytes()).decode("ascii")
                    proc.stdin.write(json.dumps({"type": "audio", "pcm": b64, "seq": idx}) + "\n")
                    proc.stdin.flush()
                    time.sleep(0.01)

                silence_b64 = base64.b64encode(np.zeros(1600, dtype="<i2").tobytes()).decode("ascii")
                for _ in range(15):
                    proc.stdin.write(json.dumps({"type": "audio", "pcm": silence_b64, "seq": 999}) + "\n")
                    proc.stdin.flush()
                    time.sleep(0.01)

                time.sleep(1.0)
                proc.stdin.write(json.dumps({"type": "stop"}) + "\n")
                proc.stdin.flush()

                out_lines, stderr_txt = proc.communicate(timeout=25)
                events = [json.loads(ln) for ln in out_lines.splitlines() if ln.strip()]
                types = [e.get("type") for e in events]

                self.assertEqual(proc.returncode, 0, msg=stderr_txt)
                self.assertIn("engine", types)
                eng_ev = [e for e in events if e.get("type") == "engine"][0]
                self.assertEqual(eng_ev.get("asrEngine"), "local_sensevoice")
                self.assertFalse(any(e.get("type") == "error" and e.get("fatal") for e in events))
                finals = [e for e in events if e.get("type") == "final"]
                self.assertGreaterEqual(len(finals), 1)
                self.assertEqual(types[-1], "stopped")
        finally:
            srv.shutdown()
            srv.server_close()

    def test_streaming_transcript_corrector_with_mock_sse(self) -> None:
        import http.server

        class MockSseHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                _ = self.rfile.read(length)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.end_headers()
                chunks = ["我们今天", "聊聊", "点波播客工作流。"]
                for ch in chunks:
                    payload = {"choices": [{"delta": {"content": ch}}]}
                    self.wfile.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    time.sleep(0.07)
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

            def log_message(self, fmt: str, *args: object) -> None:
                return

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockSseHandler)
        port = srv.server_address[1]
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            events: list[tuple[str, str, str, str]] = []
            corrector = live_session.LiveTranscriptCorrector(
                llm_config={
                    "provider": "deepseek",
                    "apiKey": "sk-mock-stream",
                    "baseUrl": f"http://127.0.0.1:{port}/v1",
                    "model": "deepseek-chat",
                },
                topic="播客剪辑",
                hotwords=["点波", "播客工作流"],
                enabled=True,
                on_correction=lambda uid, st, cor, raw: events.append((uid, st, cor, raw)),
            )
            corrector.start()
            corrector.enqueue({"id": "u_1", "text": "我们今天聊聊点波波客工作流"})
            time.sleep(0.5)
            corrector.stop(timeout_sec=3.0)

            statuses = [e[1] for e in events]
            self.assertIn("streaming", statuses)
            self.assertIn("done", statuses)
            done_ev = [e for e in events if e[1] == "done"][-1]
            self.assertEqual(done_ev[2], "我们今天聊聊点波播客工作流。")
            self.assertEqual(done_ev[3], "我们今天聊聊点波波客工作流")
        finally:
            srv.shutdown()
            srv.server_close()

    def test_listen_scenario_prompt_and_single_speaker_resolver(self) -> None:
        self.assertIn("listen", live_session.SCENARIO_SYSTEM_PROMPTS)
        resolver = live_session.SpeakerResolver(
            speakers=[{"id": "spk_other_1", "name": "主讲人", "role": "counterpart"}],
            first_speaker_id="spk_other_1",
        )
        self.assertEqual(resolver.max_clusters, 1)
        prompt = live_session.build_live_insight_prompt(
            {
                "scenario": "listen",
                "prep": {
                    "topic": "AI Agent 工程化",
                    "counterpartName": "李四",
                    "counterpartBackground": "架构师",
                    "outline": [{"id": "ol_1", "text": "成本如何优化", "status": "not_started"}],
                },
                "speakers": [{"id": "spk_other_1", "name": "李四", "role": "counterpart"}],
                "utterances": [
                    {
                        "id": "u_1",
                        "speakerId": "spk_other_1",
                        "startMs": 1000,
                        "text": "今天分享三个工程实践，核心是通过缓存降低延迟。",
                    }
                ],
                "lastSummarizedMs": -1,
                "prevInsight": {},
                "adoptedQuestions": [],
                "dismissedQuestions": [],
            }
        )
        self.assertIn("主讲人/嘉宾: 李四", prompt)
        self.assertIn("讲座议程 / 关注问题", prompt)
        self.assertIn("Q&A", prompt)

    def test_speaker_resolver_add_and_assign_speaker(self) -> None:
        resolver = live_session.SpeakerResolver(
            speakers=[
                {"id": "spk_self", "name": "我", "role": "self"},
                {"id": "spk_other", "name": "嘉宾A", "role": "counterpart"},
            ],
            first_speaker_id="spk_self",
        )
        resolver.resolve("u_1", 0, 500, cloud_speaker_id="1")
        added = resolver.add_speaker("spk_guest_2", "嘉宾B", "counterpart")
        self.assertEqual(added["id"], "spk_guest_2")
        self.assertIn("spk_guest_2", resolver.speaker_ids)

        upd = resolver.assign("u_1", "spk_guest_2", apply_to_label=True)
        self.assertIsNotNone(upd)
        assert upd is not None
        self.assertEqual(upd["speakerId"], "spk_guest_2")
        self.assertEqual(upd["speakerSource"], "manual")

    def test_scenario_prompt_adaptations(self) -> None:
        # 1. Dialogue without host
        dialogue_prompt = live_session.build_live_insight_prompt(
            {
                "scenario": "dialogue",
                "prep": {"topic": "AI 趋势", "hasHost": False},
                "speakers": [
                    {"id": "spk_other_1", "name": "嘉宾甲", "role": "counterpart"},
                    {"id": "spk_other_2", "name": "嘉宾乙", "role": "counterpart"},
                    {"id": "spk_other_3", "name": "嘉宾丙", "role": "counterpart"},
                ],
                "utterances": [
                    {"id": "u1", "speakerId": "spk_other_1", "startMs": 1000, "text": "我觉得模型变小了。"}
                ],
                "lastSummarizedMs": -1,
            }
        )
        self.assertIn("无主持人", dialogue_prompt)
        self.assertIn("固定 3 人", dialogue_prompt)
        self.assertIn("嘉宾甲(对谈嘉宾)", dialogue_prompt)

        # 2. Interview with 1 interviewer and multiple respondents
        interview_prompt = live_session.build_live_insight_prompt(
            {
                "scenario": "interview",
                "prep": {"topic": "创业复盘"},
                "speakers": [
                    {"id": "spk_self", "name": "主持人", "role": "self"},
                    {"id": "spk_other_1", "name": "张三", "role": "counterpart"},
                    {"id": "spk_other_2", "name": "李四", "role": "counterpart"},
                ],
                "utterances": [
                    {"id": "u1", "speakerId": "spk_self", "startMs": 1000, "text": "当时怎么起步的？"},
                    {"id": "u2", "speakerId": "spk_other_1", "startMs": 3000, "text": "我们从开源起步。"},
                ],
                "lastSummarizedMs": -1,
            }
        )
        self.assertIn("1位主提问人 + 2位回答人/讲述人", interview_prompt)
        self.assertIn("张三, 李四", interview_prompt)

        # 3. Listen/keynote mode filtering private discussion
        listen_prompt = live_session.build_live_insight_prompt(
            {
                "scenario": "listen",
                "prep": {"topic": "架构分享", "captureAudience": True},
                "speakers": [
                    {"id": "spk_other_1", "name": "王讲师", "role": "counterpart", "speakerKind": "keynote"},
                    {"id": "spk_audience", "name": "提问/私下讨论", "role": "self", "speakerKind": "audience"},
                ],
                "utterances": [
                    {"id": "u1", "speakerId": "spk_other_1", "startMs": 1000, "text": "核心是异步队列解耦。"},
                    {"id": "u2", "speakerId": "spk_audience", "startMs": 3000, "text": "待会中午吃什么？"},
                ],
                "lastSummarizedMs": -1,
            }
        )
        self.assertIn("主要提取主讲人", listen_prompt)
        self.assertIn("私下讨论", listen_prompt)
        self.assertIn("王讲师(主讲人)", listen_prompt)
        self.assertIn("提问/私下讨论(现场提问/私下讨论)", listen_prompt)

    def test_target_fields_prompt_and_normalize(self) -> None:
        tf_list = [
            {"id": "tf_1", "label": "预算范围"},
            {"id": "tf_2", "label": "上线时间"},
        ]
        prompt = live_session.build_live_insight_prompt(
            {
                "scenario": "sales",
                "prep": {"topic": "企业采购", "targetFields": tf_list},
                "speakers": [
                    {"id": "spk_self", "name": "销售", "role": "self"},
                    {"id": "spk_other_1", "name": "王总", "role": "counterpart"},
                ],
                "utterances": [
                    {"id": "u1", "speakerId": "spk_other_1", "startMs": 2000, "text": "今年大概有50万预算。"}
                ],
                "lastSummarizedMs": -1,
            }
        )
        self.assertIn("希望获取的关键信息 / 字段清单", prompt)
        self.assertIn("tf_1: 预算范围", prompt)
        self.assertIn("targetField", prompt)

        norm1 = live_session.normalize_live_insight(
            {
                "profile": {},
                "questions": [
                    {
                        "type": "advance",
                        "text": "您期望大概什么时候上线这套系统？",
                        "why": "确认交付周期",
                        "relatedTo": "项目排期",
                        "targetField": "上线时间",
                    }
                ],
                "targetFieldUpdates": [
                    {"id": "tf_1", "status": "captured", "value": "约50万", "evidenceMs": 2000},
                    {"id": "tf_2", "status": "missing", "value": "", "evidenceMs": 0},
                ],
            },
            scenario="sales",
            target_fields=tf_list,
        )
        self.assertEqual(norm1["questions"][0]["targetField"], "上线时间")
        self.assertEqual(norm1["targetFieldUpdates"][0]["status"], "captured")
        self.assertEqual(norm1["targetFieldUpdates"][0]["value"], "约50万")

        # Subsequent update should preserve previously captured field even if LLM returns missing
        norm2 = live_session.normalize_live_insight(
            {
                "profile": {},
                "questions": [],
                "targetFieldUpdates": [
                    {"id": "tf_1", "status": "missing", "value": "", "evidenceMs": 0},
                    {"id": "tf_2", "status": "captured", "value": "Q3前上线", "evidenceMs": 8000},
                ],
            },
            scenario="sales",
            prev=norm1,
            target_fields=tf_list,
        )
        by_id = {x["id"]: x for x in norm2["targetFieldUpdates"]}
        self.assertEqual(by_id["tf_1"]["status"], "captured")
        self.assertEqual(by_id["tf_1"]["value"], "约50万")
        self.assertEqual(by_id["tf_2"]["status"], "captured")

    def test_chat_scenario_topic_flow_prompt_and_normalize(self) -> None:
        prompt = live_session.build_live_insight_prompt(
            {
                "scenario": "chat",
                "prep": {"topic": "Q4 产品规划"},
                "speakers": [
                    {"id": "spk_self", "name": "我", "role": "self"},
                    {"id": "spk_other_1", "name": "张三", "role": "counterpart"},
                    {"id": "spk_other_2", "name": "李四", "role": "counterpart"},
                ],
                "utterances": [
                    {"id": "u1", "speakerId": "spk_other_1", "startMs": 3000, "text": "我们先对一下Q4优先级。"},
                    {"id": "u2", "speakerId": "spk_other_2", "startMs": 15000, "text": "顺便聊聊AI录音分析的UI。"},
                ],
                "lastSummarizedMs": -1,
            }
        )
        self.assertIn("聊天讨论模式", prompt)
        self.assertIn("currentTopic", prompt)
        self.assertIn("topicFlow", prompt)

        norm = live_session.normalize_live_insight(
            {
                "profile": {},
                "questions": [],
                "currentTopic": "AI 录音分析 UI",
                "topicFlow": [
                    {
                        "id": "t1",
                        "topic": "Q4 优先级对齐",
                        "status": "ended",
                        "relevance": "high",
                        "relevanceNote": "紧扣主题",
                        "startMs": 3000,
                        "speakers": ["张三"],
                    },
                    {
                        "id": "t2",
                        "topic": "AI 录音分析 UI",
                        "status": "active",
                        "relevance": "medium",
                        "relevanceNote": "延伸讨论具体界面",
                        "transitionFrom": "Q4 优先级对齐",
                        "startMs": 15000,
                        "speakers": ["李四"],
                    },
                ],
            },
            scenario="chat",
        )
        self.assertEqual(norm["currentTopic"], "AI 录音分析 UI")
        self.assertEqual(len(norm["topicFlow"]), 2)
        self.assertEqual(norm["topicFlow"][0]["status"], "ended")
        self.assertEqual(norm["topicFlow"][1]["status"], "active")
        self.assertEqual(norm["topicFlow"][1]["relevance"], "medium")


if __name__ == "__main__":
    unittest.main()
