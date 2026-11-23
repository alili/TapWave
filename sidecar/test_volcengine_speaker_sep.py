#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unit & local mock HTTP server tests for Volcengine Doubao Voice Speaker Separation."""

from http.server import BaseHTTPRequestHandler, HTTPServer
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


class VolcengineSpeakerSeparationTests(unittest.TestCase):
    def test_end_to_end_mock_openapi_auc_and_complementary_wav_split(self) -> None:
        state = {
            "openapi_calls": [],
            "api_keys": [],
            "submit_reqs": [],
            "query_count": 0,
        }

        class MockVolcHandler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args) -> None:  # noqa: A002
                pass

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(length).decode("utf-8")
                body = json.loads(raw_body) if raw_body.strip() else {}

                if "Action=" in self.path:
                    auth = self.headers.get("Authorization", "")
                    x_date = self.headers.get("X-Date", "")
                    x_sha = self.headers.get("X-Content-Sha256", "")
                    action = self.path.split("Action=")[1].split("&")[0]
                    state["openapi_calls"].append(
                        {
                            "action": action,
                            "auth": auth,
                            "x_date": x_date,
                            "x_sha": x_sha,
                            "body": body,
                        }
                    )

                    if action == "ListAPIKeys":
                        resp = {
                            "ResponseMetadata": {"Action": "ListAPIKeys"},
                            "Result": {"APIKeys": list(state["api_keys"])},
                        }
                    elif action == "CreateAPIKey":
                        new_key = "volc_mock_api_key_9988"
                        state["api_keys"].append(
                            {"APIKey": new_key, "Disable": False, "Name": body.get("Name")}
                        )
                        resp = {
                            "ResponseMetadata": {"Action": "CreateAPIKey"},
                            "Result": {},
                        }
                    else:
                        resp = {"ResponseMetadata": {"Action": action}, "Result": {}}

                    payload = json.dumps(resp).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return

                if self.path == "/api/v3/auc/bigmodel/submit":
                    state["submit_reqs"].append(
                        {
                            "headers": {k: v for k, v in self.headers.items()},
                            "body": body,
                        }
                    )
                    self.send_response(200)
                    self.send_header("X-Api-Status-Code", "20000000")
                    self.send_header("X-Api-Message", "OK")
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b"{}")
                    return

                if self.path == "/api/v3/auc/bigmodel/query":
                    state["query_count"] += 1
                    if state["query_count"] == 1:
                        self.send_response(200)
                        self.send_header("X-Api-Status-Code", "20000001")
                        self.send_header("X-Api-Message", "Processing")
                        self.end_headers()
                        self.wfile.write(b"{}")
                        return

                    result_payload = {
                        "audio_info": {"duration": 4000},
                        "result": {
                            "text": "你好，欢迎收听本期播客。谢谢邀请！",
                            "utterances": [
                                {
                                    "start_time": 120,
                                    "end_time": 1820,
                                    "text": "你好，欢迎收听本期播客。",
                                    "additions": {"speaker": "1"},
                                    "words": [
                                        {"text": "你", "start_time": 120, "end_time": 340},
                                        {"text": "好", "start_time": 340, "end_time": 580},
                                        {"text": "欢", "start_time": 660, "end_time": 900},
                                        {"text": "迎", "start_time": 900, "end_time": 1150},
                                        {"text": "收", "start_time": 1150, "end_time": 1380},
                                        {"text": "听", "start_time": 1380, "end_time": 1600},
                                        {"text": "播客", "start_time": 1600, "end_time": 1820},
                                    ],
                                },
                                {
                                    "start_time": 2150,
                                    "end_time": 3780,
                                    "text": "谢谢邀请！",
                                    "additions": {"speaker": "2"},
                                    "words": [
                                        {"text": "谢", "start_time": 2150, "end_time": 2450},
                                        {"text": "谢", "start_time": 2450, "end_time": 2750},
                                        {"text": "邀", "start_time": 2800, "end_time": 3250},
                                        {"text": "请", "start_time": 3250, "end_time": 3780},
                                    ],
                                },
                            ],
                        },
                    }
                    raw = json.dumps(result_payload, ensure_ascii=False).encode("utf-8")
                    self.send_response(200)
                    self.send_header("X-Api-Status-Code", "20000000")
                    self.send_header("X-Api-Message", "OK")
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return

                self.send_response(404)
                self.end_headers()

        server = HTTPServer(("127.0.0.1", 0), MockVolcHandler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                # Synthesize 4.0s @ 16kHz test WAV with distinct voices in [0.1s..1.85s] and [2.1s..3.8s]
                sr16 = 16000
                dur_sec = 4.0
                t16 = np.arange(int(sr16 * dur_sec), dtype=np.float32) / sr16
                sig16 = np.zeros_like(t16)
                m1 = (t16 >= 0.1) & (t16 <= 1.85)
                m2 = (t16 >= 2.1) & (t16 <= 3.8)
                sig16[m1] = 0.45 * np.sin(2 * np.pi * 160.0 * t16[m1])
                sig16[m2] = 0.45 * np.sin(2 * np.pi * 240.0 * t16[m2])

                input_wav = os.path.join(tmpdir, "mixed_dialog.wav")
                with wave.open(input_wav, "wb") as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(sr16)
                    wf.writeframes((sig16 * 32767.0).astype("<i2").tobytes())

                cache_file = os.path.join(tmpdir, "cache.json")
                base_url = f"http://127.0.0.1:{port}"
                asr_cfg = {
                    "provider": "volcengine_doubao",
                    "volcAccountId": "2134470279",
                    "volcAccessKeyId": "AKLT_TEST_KEY",
                    "volcSecretAccessKey": "SECRET_TEST_KEY",
                    "volcSsdVersion": "200",
                    "enableSingleFileSpeakerSep": True,
                }

                speaker_order, segments, tokens_by_speaker = podcraft_ai.transcribe_with_volcengine_auc(
                    sig16,
                    asr_config=asr_cfg,
                    hotwords=["PodCraft"],
                    auc_base_url=base_url,
                    openapi_base_url=base_url,
                    cache_path=cache_file,
                    poll_interval_sec=0.02,
                    max_wait_sec=5.0,
                )

                # Verify OpenAPI ListAPIKeys -> CreateAPIKey -> ListAPIKeys & HMAC-SHA256 signing
                actions = [c["action"] for c in state["openapi_calls"]]
                self.assertEqual(actions, ["ListAPIKeys", "CreateAPIKey", "ListAPIKeys"])
                for call in state["openapi_calls"]:
                    self.assertTrue(call["auth"].startswith("HMAC-SHA256 Credential=AKLT_TEST_KEY/"))
                    self.assertIn("/cn-beijing/speech_saas_prod/request", call["auth"])
                    self.assertTrue(call["x_date"].endswith("Z"))
                    self.assertEqual(len(call["x_sha"]), 64)

                # Verify AUC submit headers & speaker-separation body parameters
                self.assertEqual(len(state["submit_reqs"]), 1)
                sub_hdrs = {k.lower(): v for k, v in state["submit_reqs"][0]["headers"].items()}
                sub_body = state["submit_reqs"][0]["body"]
                self.assertEqual(sub_hdrs.get("x-api-key"), "volc_mock_api_key_9988")
                self.assertEqual(sub_hdrs.get("x-api-resource-id"), "volc.seedasr.auc")
                self.assertEqual(sub_hdrs.get("x-api-sequence"), "-1")
                self.assertTrue(bool(sub_hdrs.get("x-api-request-id")))
                self.assertEqual(sub_body["request"]["enable_speaker_info"], True)
                self.assertEqual(sub_body["request"]["show_utterances"], True)
                self.assertEqual(sub_body["request"]["ssd_version"], "200")
                self.assertEqual(state["query_count"], 2)

                # Verify parsed speakers and punctuation alignment
                self.assertEqual(speaker_order, ["1", "2"])
                self.assertEqual(len(segments), 2)
                sp1_text = "".join(t["text"] for t in tokens_by_speaker["1"])
                sp2_text = "".join(t["text"] for t in tokens_by_speaker["2"])
                self.assertIn("好，", sp1_text)
                self.assertIn("播客。", sp1_text)
                self.assertIn("请！", sp2_text)

                # Verify complementary 48kHz WAV separation
                sep_out_dir = os.path.join(tmpdir, "stems")
                sep_meta, sep_results = podcraft_ai.build_separated_speaker_tracks(
                    file_path=input_wav,
                    speaker_order=speaker_order,
                    segments=segments,
                    tokens_by_speaker=tokens_by_speaker,
                    engine_name="volcengine_doubao",
                    fallback_samples_16k=sig16,
                    output_dir=sep_out_dir,
                )

                self.assertEqual(len(sep_meta), 2)
                self.assertEqual(sep_meta[0]["id"], "sp_1")
                self.assertEqual(sep_meta[0]["role"], "host")
                self.assertEqual(sep_meta[1]["id"], "sp_2")
                self.assertEqual(sep_meta[1]["role"], "guest")
                self.assertEqual(len(sep_meta[0]["peaks"]), 1200)
                self.assertEqual(len(sep_results["sp_1"]["tokens"]), len(tokens_by_speaker["1"]))
                self.assertEqual(len(sep_results["sp_2"]["tokens"]), len(tokens_by_speaker["2"]))

                # Verify sample-exact complementarity: stem1 + stem2 == original 48kHz PCM (<= 2 int16 LSB)
                orig_48k = podcraft_ai.decode_audio_48khz_mono_i16(input_wav, fallback_samples_16k=sig16)
                stems_pcm = []
                for m in sep_meta:
                    with wave.open(m["filePath"], "rb") as wf:
                        self.assertEqual(wf.getnchannels(), 1)
                        self.assertEqual(wf.getsampwidth(), 2)
                        self.assertEqual(wf.getframerate(), 48000)
                        stems_pcm.append(np.frombuffer(wf.readframes(wf.getnframes()), dtype="<i2"))

                summed = stems_pcm[0].astype(np.int32) + stems_pcm[1].astype(np.int32)
                max_err = int(np.max(np.abs(summed - orig_48k.astype(np.int32))))
                self.assertLessEqual(max_err, 2)
        finally:
            server.shutdown()
            server.server_close()

    def test_handle_analyze_live_speakers_and_content_diarization_fallback(self) -> None:
        # 1. podcraft_ai.handle_analyze_live_speakers local_rules integration
        res = podcraft_ai.handle_analyze_live_speakers(
            {
                "command": "analyze_live_speakers",
                "scenario": "interview",
                "speakers": [
                    {"id": "spk_self", "name": "我", "role": "self"},
                    {"id": "spk_other", "name": "嘉宾", "role": "counterpart"},
                ],
                "utterances": [
                    {"id": "u1", "text": "请问您当时为什么选择开源这条路？", "startMs": 0, "endMs": 3000, "speakerId": "spk_self", "speakerSource": "manual"},
                    {"id": "u2", "text": "谢谢邀请，我是觉得开源社区能带来最直接的反馈。", "startMs": 3500, "endMs": 8000, "speakerId": "spk_self", "speakerSource": "fallback"},
                ],
                "mode": "hybrid",
                "llmConfig": {"provider": "local_only"},
            }
        )
        self.assertTrue(res["ok"])
        self.assertEqual(res["engine"], "local_rules")
        self.assertEqual(len(res["reassignments"]), 1)
        self.assertEqual(res["reassignments"][0]["speakerId"], "spk_other")

        # 2. diarize_single_track_locally content fallback when acoustic voice is identical
        sr = 16000
        t = np.arange(sr * 8, dtype=np.float32) / sr
        uniform_voice = 0.3 * np.sin(2 * np.pi * 180.0 * t)
        dialogue_tokens = [
            {"text": "请问你对今年行业变化怎么看？", "startMs": 0, "endMs": 1500},
            {"text": "谢谢邀请，我觉得AI工程化正在加速落地。", "startMs": 2200, "endMs": 4000},
            {"text": "能具体聊聊成本控制吗？", "startMs": 4700, "endMs": 6000},
            {"text": "关于你刚才的问题，核心是做好量化与缓存。", "startMs": 6700, "endMs": 7900},
        ]
        sp_order, _, _ = podcraft_ai.diarize_single_track_locally(uniform_voice, dialogue_tokens)
        self.assertEqual(len(sp_order), 2)

        # Pure monologue should stay 1 speaker
        monologue_tokens = [
            {"text": "今天我来分享一下端侧部署的经验。", "startMs": 0, "endMs": 1800},
            {"text": "首先我们需要关注内存占用。", "startMs": 2500, "endMs": 4200},
            {"text": "其次是首字延迟的优化。", "startMs": 5000, "endMs": 6800},
        ]
        mono_order, _, _ = podcraft_ai.diarize_single_track_locally(uniform_voice, monologue_tokens)
        self.assertEqual(len(mono_order), 1)


if __name__ == "__main__":
    unittest.main()
