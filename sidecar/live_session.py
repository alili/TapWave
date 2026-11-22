#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Persistent live-recording sidecar process (`python -u podcraft_ai.py live`).
Reads NDJSON commands on stdin, streams audio to Volcengine SAUC v3 WebSocket ASR,
resolves speakers (cloud speaker ID -> local voiceprint clustering -> manual override),
runs LiveCopilot LLM insights, writes 16kHz mono WAV + session.json, and emits NDJSON events.
"""

from __future__ import annotations

import base64
import collections
import hashlib
import json
import os
import queue
import sys
import threading
import time
import urllib.request
import uuid
import wave
from typing import Any, Callable, Deque, Dict, Iterator, List, Optional, Tuple

import numpy as np  # type: ignore

SIDECAR_DIR = os.path.dirname(os.path.abspath(__file__))
if SIDECAR_DIR not in sys.path:
    sys.path.insert(0, SIDECAR_DIR)

import podcraft_ai  # noqa: E402
from live_ws import (  # noqa: E402
    SimpleWebSocket,
    WsClosed,
    WsHandshakeError,
    build_audio_frame,
    build_full_client_request,
    parse_volc_frame,
)


VOLC_SAUC_WS_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
VOLC_STREAM_RESOURCE_CANDIDATES = [
    "volc.bigasr.sauc.duration",
    "volc.seedasr.sauc.duration",
]
LIVE_SAMPLE_RATE = 16000
LIVE_VOICEPRINT_NEW_CLUSTER_DIST = 0.22
AUDIO_RING_MAX_SEC = 180
RECONNECT_BUFFER_MAX_BYTES = LIVE_SAMPLE_RATE * 2 * 30  # 30s of 16k Int16


def _format_mm_ss(ms: int) -> str:
    total_sec = max(0, int(ms // 1000))
    m, s = divmod(total_sec, 60)
    return f"{m:02d}:{s:02d}"


def _extract_json_obj(raw: str) -> Dict[str, Any]:
    txt = (raw or "").strip()
    if txt.startswith("```"):
        lines = txt.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        txt = "\n".join(lines).strip()
    try:
        obj = json.loads(txt)
        return obj if isinstance(obj, dict) else {}
    except Exception:
        start = txt.find("{")
        end = txt.rfind("}")
        if start != -1 and end > start:
            try:
                obj = json.loads(txt[start : end + 1])
                return obj if isinstance(obj, dict) else {}
            except Exception:
                return {}
        return {}


class UtteranceTracker:
    """
    Tracks streaming ASR utterances for a single WS connection (with base time offset).
    Deduplicates definite finals and emits the latest non-definite text as partial.
    """

    def __init__(self, offset_ms: int = 0) -> None:
        self.offset_ms = max(0, int(offset_ms))
        self._committed_keys: set[Tuple[int, int, str]] = set()
        self._last_final_end_rel_ms = -1
        self._last_partial_key: Optional[Tuple[str, Optional[str]]] = None

    def process_payload(
        self, payload: Dict[str, Any]
    ) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Any]]]:
        result = payload.get("result")
        if not isinstance(result, dict):
            return [], None

        utterances = result.get("utterances")
        finals: List[Dict[str, Any]] = []
        latest_partial: Optional[Dict[str, Any]] = None

        if isinstance(utterances, list) and utterances:
            for utt in utterances:
                if not isinstance(utt, dict):
                    continue
                text = str(utt.get("text") or "").strip()
                if not text:
                    continue
                rel_start = int(utt.get("start_time") or 0)
                rel_end = int(utt.get("end_time") or rel_start)
                abs_start = self.offset_ms + max(0, rel_start)
                abs_end = self.offset_ms + max(rel_start, rel_end)

                additions = utt.get("additions") if isinstance(utt.get("additions"), dict) else {}
                raw_spk = (
                    utt.get("speaker_id")
                    if utt.get("speaker_id") not in (None, "")
                    else additions.get("speaker")
                    if additions.get("speaker") not in (None, "")
                    else utt.get("speaker")
                )
                cloud_spk = str(raw_spk).strip() if raw_spk not in (None, "") else None

                is_definite = bool(utt.get("definite"))
                if is_definite:
                    key = (rel_start, rel_end, text)
                    if key not in self._committed_keys and rel_end > self._last_final_end_rel_ms:
                        self._committed_keys.add(key)
                        self._last_final_end_rel_ms = rel_end
                        finals.append(
                            {
                                "text": text,
                                "startMs": abs_start,
                                "endMs": abs_end,
                                "cloudSpeakerId": cloud_spk,
                            }
                        )
                else:
                    latest_partial = {
                        "text": text,
                        "startMs": abs_start,
                        "endMs": abs_end,
                        "cloudSpeakerId": cloud_spk,
                    }
        else:
            full_text = str(result.get("text") or "").strip()
            if full_text:
                latest_partial = {
                    "text": full_text,
                    "startMs": self.offset_ms,
                    "endMs": self.offset_ms,
                    "cloudSpeakerId": None,
                }

        if finals:
            self._last_partial_key = None
        elif latest_partial is not None:
            p_key = (latest_partial["text"], latest_partial.get("cloudSpeakerId"))
            if p_key == self._last_partial_key:
                latest_partial = None
            else:
                self._last_partial_key = p_key

        return finals, latest_partial


class AudioRingBuffer:
    """Keeps up to `max_seconds` of recent 16kHz Int16 PCM indexed by session ms."""

    def __init__(self, max_seconds: int = AUDIO_RING_MAX_SEC, sample_rate: int = LIVE_SAMPLE_RATE) -> None:
        self._sr = sample_rate
        self._max_samples = max_seconds * sample_rate
        self._chunks: Deque[Tuple[int, np.ndarray]] = collections.deque()
        self._total_samples = 0

    def append(self, pcm_int16: np.ndarray) -> int:
        if pcm_int16.size == 0:
            return self.total_ms
        start_sample = self._total_samples
        self._chunks.append((start_sample, pcm_int16))
        self._total_samples += int(pcm_int16.size)
        cutoff = self._total_samples - self._max_samples
        while self._chunks and (self._chunks[0][0] + int(self._chunks[0][1].size)) < cutoff:
            self._chunks.popleft()
        return self.total_ms

    @property
    def total_ms(self) -> int:
        return int(round((self._total_samples / float(self._sr)) * 1000.0))

    def slice_int16(self, start_ms: int, end_ms: int) -> np.ndarray:
        s0 = max(0, int((start_ms / 1000.0) * self._sr))
        s1 = max(s0, int((end_ms / 1000.0) * self._sr))
        if s1 <= s0 or not self._chunks:
            return np.zeros(0, dtype="<i2")

        parts: List[np.ndarray] = []
        for chunk_start, arr in self._chunks:
            chunk_end = chunk_start + int(arr.size)
            if chunk_end <= s0 or chunk_start >= s1:
                continue
            lo = max(0, s0 - chunk_start)
            hi = min(int(arr.size), s1 - chunk_start)
            if hi > lo:
                parts.append(arr[lo:hi])
        if not parts:
            return np.zeros(0, dtype="<i2")
        return np.concatenate(parts)

    def slice_float32(self, start_ms: int, end_ms: int) -> np.ndarray:
        joined = self.slice_int16(start_ms, end_ms)
        if joined.size == 0:
            return np.zeros(0, dtype=np.float32)
        return joined.astype(np.float32) / 32768.0


class SpeakerResolver:
    """
    Resolves utterance speakers via 3 tiers:
      1. Cloud speaker_id (`c<id>`)
      2. Online acoustic voiceprint clustering (`v<k>`) using podcraft_ai._extract_speaker_feature_vector
      3. Manual assignment (`assign`), optionally updating label_map & cluster centroid
    """

    def __init__(
        self,
        speakers: List[Dict[str, Any]],
        first_speaker_id: Optional[str] = None,
    ) -> None:
        self.speakers = list(speakers) if speakers else [
            {"id": "spk_self", "name": "我", "role": "self"},
            {"id": "spk_other", "name": "对方", "role": "counterpart"},
        ]
        self.speaker_ids = [str(s["id"]) for s in self.speakers]
        self.first_speaker_id = (
            first_speaker_id if first_speaker_id in self.speaker_ids else self.speaker_ids[0]
        )
        self.max_clusters = max(1, len(self.speaker_ids))
        self.ring = AudioRingBuffer()
        self.label_map: Dict[str, str] = {}
        self.centroids: Dict[str, Tuple[np.ndarray, int]] = {}
        self._next_cluster_idx = 0
        self._last_speaker_id = self.first_speaker_id
        self._utterances: Dict[str, Dict[str, Any]] = {}
        self._utterance_labels: Dict[str, Optional[str]] = {}
        self._utterance_features: Dict[str, np.ndarray] = {}
        self._utterance_vp_meta: Dict[str, Dict[str, Any]] = {}
        self._last_cluster_dist: float = 0.0
        self._lock = threading.Lock()

    def append_audio(self, pcm_int16: np.ndarray) -> int:
        with self._lock:
            return self.ring.append(pcm_int16)

    def add_speaker(
        self, speaker_id: str, name: str, role: str = "counterpart"
    ) -> Dict[str, Any]:
        sid = str(speaker_id or "").strip()
        sname = str(name or "").strip() or "新发言人"
        srole = "self" if role == "self" else "counterpart"
        with self._lock:
            for existing in self.speakers:
                if str(existing.get("id")) == sid:
                    return dict(existing)
            speaker_obj = {"id": sid, "name": sname, "role": srole}
            self.speakers.append(speaker_obj)
            self.speaker_ids.append(sid)
            self.max_clusters = max(self.max_clusters, len(self.speaker_ids))
            return dict(speaker_obj)

    def rename_speaker(self, speaker_id: str, new_name: str) -> bool:
        sid = str(speaker_id or "").strip()
        sname = str(new_name or "").strip()
        if not sid or not sname:
            return False
        with self._lock:
            for existing in self.speakers:
                if str(existing.get("id")) == sid:
                    existing["name"] = sname
                    return True
            return False

    def _allocate_speaker_for_label(self, label: str) -> str:
        if label in self.label_map:
            return self.label_map[label]
        if not self.label_map:
            chosen = self.first_speaker_id
        else:
            used = set(self.label_map.values())
            unused = [sid for sid in self.speaker_ids if sid not in used]
            if unused:
                chosen = unused[0]
            else:
                chosen = self.speaker_ids[len(self.label_map) % len(self.speaker_ids)]
        self.label_map[label] = chosen
        return chosen

    def _cluster_feature(self, feat: np.ndarray) -> str:
        if not self.centroids:
            label = f"v{self._next_cluster_idx}"
            self._next_cluster_idx += 1
            self.centroids[label] = (feat.copy(), 1)
            self._last_cluster_dist = 0.0
            return label

        best_label = ""
        best_dist = 999.0
        for label, (centroid, _cnt) in self.centroids.items():
            dist = float(np.linalg.norm(feat - centroid))
            if dist < best_dist:
                best_dist = dist
                best_label = label

        if best_dist < LIVE_VOICEPRINT_NEW_CLUSTER_DIST or len(self.centroids) >= self.max_clusters:
            centroid, cnt = self.centroids[best_label]
            alpha = 1.0 / float(min(cnt + 1, 12))
            updated = (1.0 - alpha) * centroid + alpha * feat
            self.centroids[best_label] = (updated, cnt + 1)
            self._last_cluster_dist = best_dist
            return best_label

        label = f"v{self._next_cluster_idx}"
        self._next_cluster_idx += 1
        self.centroids[label] = (feat.copy(), 1)
        self._last_cluster_dist = 0.0
        return label

    def resolve(
        self,
        utterance_id: str,
        start_ms: int,
        end_ms: int,
        cloud_speaker_id: Optional[str] = None,
    ) -> Tuple[str, str, str]:
        """Returns (speaker_id, label, speaker_source)."""
        with self._lock:
            dur_ms = max(0, end_ms - start_ms)
            feat = None
            if dur_ms >= 800:
                seg = self.ring.slice_float32(start_ms, end_ms)
                if seg.size >= 1600:
                    feat = podcraft_ai._extract_speaker_feature_vector(seg)

            vp_cluster = ""
            vp_conf: Optional[float] = None
            if feat is not None:
                self._utterance_features[utterance_id] = feat.copy()

            if cloud_speaker_id not in (None, ""):
                label = f"c{cloud_speaker_id}"
                spk_id = self._allocate_speaker_for_label(label)
                source = "cloud"
                vp_cluster = label
                vp_conf = 0.95
            else:
                if feat is not None:
                    label = self._cluster_feature(feat)
                    spk_id = self._allocate_speaker_for_label(label)
                    source = "voiceprint"
                    vp_cluster = label
                    denom = max(0.1, LIVE_VOICEPRINT_NEW_CLUSTER_DIST * 1.6)
                    vp_conf = round(max(0.45, min(0.99, 1.0 - self._last_cluster_dist / denom)), 2)
                else:
                    label = ""
                    spk_id = self._last_speaker_id
                    source = "fallback"

            if vp_cluster or feat is not None:
                vp_meta: Dict[str, Any] = {}
                if vp_cluster:
                    vp_meta["voiceprintCluster"] = vp_cluster
                if vp_conf is not None:
                    vp_meta["voiceprintConfidence"] = vp_conf
                if feat is not None:
                    vp_meta["voiceprintVector"] = [round(float(x), 4) for x in feat[:16]]
                self._utterance_vp_meta[utterance_id] = vp_meta

            self._last_speaker_id = spk_id
            self._utterance_labels[utterance_id] = label or None
            self._utterances[utterance_id] = {
                "id": utterance_id,
                "startMs": start_ms,
                "endMs": end_ms,
                "speakerId": spk_id,
                "speakerLabel": label,
                "speakerSource": source,
                **self._utterance_vp_meta.get(utterance_id, {}),
            }
            return spk_id, label, source

    def get_utterance_voiceprint(self, utterance_id: str) -> Dict[str, Any]:
        with self._lock:
            return dict(self._utterance_vp_meta.get(utterance_id, {}))

    def preview_speaker_for_cloud(self, cloud_speaker_id: Optional[str]) -> Optional[str]:
        if cloud_speaker_id in (None, ""):
            return None
        with self._lock:
            label = f"c{cloud_speaker_id}"
            return self.label_map.get(label)

    def _find_similar_utterances_locked(
        self, utterance_id: str, target_speaker_id: str
    ) -> List[Dict[str, Any]]:
        src_utt = self._utterances.get(utterance_id)
        if not src_utt:
            return []
        src_label = self._utterance_labels.get(utterance_id) or src_utt.get("voiceprintCluster")
        src_feat = self._utterance_features.get(utterance_id)

        candidates: List[Dict[str, Any]] = []
        for uid, u in self._utterances.items():
            if uid == utterance_id:
                continue
            if u.get("speakerId") == target_speaker_id:
                continue
            if u.get("speakerSource") == "manual":
                continue

            u_label = self._utterance_labels.get(uid) or u.get("voiceprintCluster")
            if src_label and u_label and src_label == u_label:
                candidates.append(
                    {
                        "utteranceId": uid,
                        "reason": f"相同声纹簇 ({src_label})",
                        "similarity": 0.95,
                    }
                )
                continue

            u_feat = self._utterance_features.get(uid)
            if src_feat is not None and u_feat is not None:
                norm_a = float(np.linalg.norm(src_feat))
                norm_b = float(np.linalg.norm(u_feat))
                if norm_a > 1e-6 and norm_b > 1e-6:
                    cos_sim = float(np.dot(src_feat, u_feat) / (norm_a * norm_b))
                    if cos_sim >= 0.86:
                        candidates.append(
                            {
                                "utteranceId": uid,
                                "reason": f"声纹特征相似 ({int(round(cos_sim * 100))}%)",
                                "similarity": round(cos_sim, 2),
                            }
                        )
        return candidates

    def assign(
        self, utterance_id: str, speaker_id: str, apply_to_label: bool = True
    ) -> Optional[Dict[str, Any]]:
        with self._lock:
            if speaker_id not in self.speaker_ids:
                return None
            utt = self._utterances.get(utterance_id)
            if utt is None:
                return None
            utt["speakerId"] = speaker_id
            utt["speakerSource"] = "manual"
            label = self._utterance_labels.get(utterance_id)
            if apply_to_label and label:
                self.label_map[label] = speaker_id
                if label.startswith("v"):
                    seg = self.ring.slice_float32(int(utt["startMs"]), int(utt["endMs"]))
                    if seg.size >= 1600:
                        feat = podcraft_ai._extract_speaker_feature_vector(seg)
                        if feat is not None:
                            if label in self.centroids:
                                old_c, cnt = self.centroids[label]
                                self.centroids[label] = (0.7 * old_c + 0.3 * feat, cnt + 1)
                            else:
                                self.centroids[label] = (feat.copy(), 1)
            suggested = self._find_similar_utterances_locked(utterance_id, speaker_id)
            result: Dict[str, Any] = {
                "utteranceId": utterance_id,
                "speakerId": speaker_id,
                "speakerSource": "manual",
            }
            if utt.get("voiceprintCluster"):
                result["voiceprintCluster"] = utt["voiceprintCluster"]
            if suggested:
                result["suggestedUtterances"] = suggested
            return result


def should_trigger_insight(
    now_sec: float,
    last_trigger_sec: float,
    chars_since_last: int,
    counterpart_turn_ended_chars: int,
    manual: bool = False,
) -> bool:
    if manual:
        return True
    elapsed = now_sec - last_trigger_sec
    if chars_since_last <= 0:
        return False
    if chars_since_last >= 120 and elapsed >= 15.0:
        return True
    if counterpart_turn_ended_chars >= 60 and elapsed >= 8.0:
        return True
    if elapsed >= 60.0 and chars_since_last >= 15:
        return True
    return False


SCENARIO_SYSTEM_PROMPTS: Dict[str, str] = {
    "interview": (
        "你是一位资深深度播客采访副驾（Live Copilot），正在实时辅助主持人采访嘉宾。"
        "你需要从最新对话中持续提炼嘉宾的背景履历、经历故事与核心观点，并给出能引出好故事或金句的下一步提问。"
        "必须严格输出合法 JSON。"
    ),
    "dialogue": (
        "你是一位专业播客对谈制片人（Live Copilot），正在实时辅助主播与嘉宾进行深度对谈。"
        "你需要提炼对方分享的背景、故事与核心观点，并给出有助于加深思辨、碰撞观点或自然转场的提问。"
        "必须严格输出合法 JSON。"
    ),
    "sales": (
        "你是一位顶级 B2B 顾问式销售教练（Live Copilot），正在实时辅助销售与客户沟通。"
        "你需要提炼客户背景、经历、观点，以及关键的痛点、需求、异议与决策信号，并给出推进成交或化解异议的口语化提问。"
        "必须严格输出合法 JSON。"
    ),
    "listen": (
        "你是一位资深知识提炼与会议笔记助手（Live Copilot），正在陪同用户聆听一场讲座或分享。"
        "你需要从主讲人的最新讲述中，持续提炼讲者背景、关键案例故事、核心观点与逻辑论据，汇总全场实时总结要点，"
        "并站在听众视角给出有深度、适合在 Q&A 环节向主讲人请教的提问建议。"
        "必须严格输出合法 JSON。"
    ),
}


def build_live_insight_prompt(ctx: Dict[str, Any]) -> str:
    scenario = ctx.get("scenario", "interview")
    prep = ctx.get("prep") or {}
    speakers = ctx.get("speakers") or []
    speaker_by_id = {str(s["id"]): s for s in speakers}
    utterances = ctx.get("utterances") or []
    last_summarized_ms = int(ctx.get("lastSummarizedMs") or -1)
    prev_insight = ctx.get("prevInsight") or {}
    outline_items = prep.get("outline") or []
    adopted = ctx.get("adoptedQuestions") or []
    dismissed = ctx.get("dismissedQuestions") or []

    # Build speaker role tag helper according to scenario
    has_host = bool(prep.get("hasHost", True))

    def _speaker_role_tag(spk: Dict[str, Any]) -> str:
        kind = str(spk.get("speakerKind") or "").strip()
        if scenario == "listen":
            if kind == "audience" or spk.get("id") == "spk_audience" or spk.get("role") == "self":
                return "现场提问/私下讨论"
            return "主讲人"
        if scenario == "dialogue":
            if not has_host:
                return "对谈嘉宾"
            return "主持人/我" if spk.get("role") == "self" else "对谈嘉宾"
        return "主提问人/我" if spk.get("role") == "self" else "回答人/对方"

    # Build recent transcript window up to 3500 chars from the end
    lines_rev: List[str] = []
    total_chars = 0
    for utt in reversed(utterances):
        spk = speaker_by_id.get(str(utt.get("speakerId")), {})
        name = spk.get("name") or "发言人"
        role_tag = _speaker_role_tag(spk)
        line = f"[{_format_mm_ss(int(utt.get('startMs') or 0))}][{name}({role_tag})]: {utt.get('text', '')}"
        if total_chars + len(line) > 3500 and lines_rev:
            break
        lines_rev.append(line)
        total_chars += len(line) + 1
    transcript_window = "\n".join(reversed(lines_rev))

    new_turn_lines: List[str] = []
    for utt in utterances:
        if int(utt.get("startMs") or 0) > last_summarized_ms:
            spk = speaker_by_id.get(str(utt.get("speakerId")), {})
            name = spk.get("name") or "发言人"
            new_turn_lines.append(
                f"[{_format_mm_ss(int(utt.get('startMs') or 0))}] speakerId={utt.get('speakerId')} ({name}): {utt.get('text', '')}"
            )

    sales_schema_hint = ""
    if scenario == "sales":
        sales_schema_hint = (
            ',\n    "sales": {\n'
            '      "painPoints": ["痛点描述"],\n'
            '      "needs": ["需求描述"],\n'
            '      "objections": [{"text": "异议内容", "handled": false, "evidenceMs": 0}],\n'
            '      "decisionSignals": [{"text": "信号描述", "polarity": "positive|negative", "evidenceMs": 0}]\n'
            "    }"
        )

    q_types = (
        "follow_up|deepen|pivot|handle_objection|advance"
        if scenario == "sales"
        else "follow_up|deepen|pivot"
    )

    outline_desc = "\n".join(
        f"- id={item.get('id')}: {item.get('text')} (当前状态: {item.get('status', 'not_started')})"
        for item in outline_items
    ) or "无预设提纲"

    prev_profile_json = json.dumps(prev_insight.get("profile") or {}, ensure_ascii=False)
    prev_keypoints_json = json.dumps(prev_insight.get("keyPoints") or [], ensure_ascii=False)

    is_listen = scenario == "listen"
    is_dialogue = scenario == "dialogue"
    counterpart_title = "主讲人/嘉宾" if is_listen else "回答人/对谈方"
    background_title = "主讲人背景/我的关注点" if is_listen else "对方背景资料"
    outline_title = "讲座议程 / 关注问题" if is_listen else "采访/沟通提纲"
    profile_heading = (
        "已有内容提炼（请在此基础上保留有效条目、去重合并并补充新发现，不要丢弃旧信息）"
        if is_listen
        else "已有画像（请在此基础上保留有效条目、去重合并并补充新发现，不要丢弃旧信息）"
    )
    if is_listen:
        mode_rule = (
            "- 模式适配（演讲模式）：仅有 1 位主讲人，其余声道可能包含听众的【现场提问】或旁听人员的【私下讨论】。\n"
            "  * 主要提取主讲人的背景、案例、观点与核心结论；\n"
            "  * 若出现有效的现场提问，可结合主讲人的回答提炼 Q&A 要点；\n"
            "  * 严禁将旁听私下讨论、闲聊或低声议论误判为主讲人观点，自动过滤无关私下讨论。\n"
        )
    elif is_dialogue:
        if has_host:
            mode_rule = (
                f"- 模式适配（对谈模式·固定 {len(speakers) or 2} 人·有主持人）："
                "辅助主持人把控节奏，综合提炼各位嘉宾的背景、故事与观点碰撞，推荐有助于深化思辨或自然转场的提问。\n"
            )
        else:
            mode_rule = (
                f"- 模式适配（对谈模式·固定 {len(speakers) or 2} 人·无主持人）："
                "所有参与者为平等对谈方，无单一主持人；请综合提炼各方核心背景、故事与观点交锋，"
                "推荐面向全场的延展话题或深化讨论切入点。\n"
            )
    else:
        respondent_names = [
            str(s.get("name") or "回答人")
            for s in speakers
            if s.get("role") != "self"
        ]
        mode_rule = (
            f"- 模式适配（{'销售' if scenario == 'sales' else '访谈'}模式·1位主提问人 + {max(1, len(respondent_names))}位回答人/讲述人）："
            f"主提问人负责引导与发问；`profile` 重点从回答人（{', '.join(respondent_names) or '对方'}）的发言中提炼背景、故事与观点"
            "（若有多位回答人，请在条目中简注发言人姓名），`questions` 供主提问人下一步追问或推进。\n"
        )

    target_fields = prep.get("targetFields") or []
    has_target_fields = (not is_listen) and (not is_dialogue) and len(target_fields) > 0
    prev_tf_map = {
        str(tf.get("id")): tf
        for tf in (prev_insight.get("targetFieldUpdates") or [])
        if isinstance(tf, dict) and tf.get("id")
    }
    target_fields_section = ""
    target_fields_schema = ""
    if has_target_fields:
        tf_lines = []
        for tf in target_fields:
            tf_id = str(tf.get("id") or "")
            tf_label = str(tf.get("label") or "").strip()
            if not tf_id or not tf_label:
                continue
            prev_tf = prev_tf_map.get(tf_id) or {}
            st = prev_tf.get("status") or "missing"
            val = prev_tf.get("value") or ""
            st_desc = f"已获取: {val}" if st == "captured" and val else ("部分提及" if st == "partial" else "尚未获取")
            tf_lines.append(f"- id={tf_id}: {tf_label} (当前状态: {st_desc})")
        if tf_lines:
            target_fields_section = "# 希望获取的关键信息 / 字段清单\n" + "\n".join(tf_lines) + "\n\n"
            target_fields_schema = ',\n  "targetFieldUpdates": [{"id": "字段id", "status": "captured|partial|missing", "value": "提取到的信息<=60字(未获取留空)", "evidenceMs": 0}]'

    question_rule = (
        f"2. `questions` 固定给出 3 条站在听众视角、适合在 Q&A 环节向主讲人请教的提问建议（type 从 {q_types} 中选择：follow_up=延伸追问, deepen=原理深挖, pivot=跨界/应用拓展）。\n"
        if is_listen
        else (
            f"2. `questions` 固定给出 3 条最值得此刻发问的建议（type 从 {q_types} 中选择）。"
            + (
                "若上述「希望获取的关键信息/字段清单」中仍有未获取（missing/partial）的字段，请优先围绕这些缺失字段设计可直接套出信息的提问，并在 `targetField` 中写明对应的字段名称（如无对应则留空）。\n"
                if has_target_fields
                else "\n"
            )
        )
    )
    keypoints_rule = (
        '  "keyPoints": ["主讲人核心总结/关键收获<=80字"],\n'
        if is_listen
        else '  "keyPoints": ["全场关键要点<=80字"],\n'
    )

    return (
        f"# 会前准备\n"
        f"- 场景: {scenario}\n"
        f"{mode_rule}"
        f"- 话题: {prep.get('topic') or '未填写'}\n"
        f"- 目标: {prep.get('goals') or '未填写'}\n"
        f"- {counterpart_title}: {', '.join(prep.get('counterpartNames') or []) or prep.get('counterpartName') or ('主讲人' if is_listen else '对方')}\n"
        f"- {background_title}: {prep.get('counterpartBackground') or '无'}\n\n"
        f"{target_fields_section}"
        f"# {outline_title}\n{outline_desc}\n\n"
        f"# {profile_heading}\n{prev_profile_json}\n\n"
        f"# 已有全场要点\n{prev_keypoints_json}\n\n"
        f"# 已问过或已忽略的问题（严禁重复推荐相同意思的问题）\n"
        f"- 已问: {json.dumps(adopted, ensure_ascii=False)}\n"
        f"- 已忽略: {json.dumps(dismissed, ensure_ascii=False)}\n\n"
        f"# 最近对话原文（含毫秒时间戳换算的 mm:ss）\n{transcript_window}\n\n"
        f"# 需要补充段落小结的新发言\n" + ("\n".join(new_turn_lines[-12:]) if new_turn_lines else "无") + "\n\n"
        f"# 输出要求（严格输出合法 JSON）\n"
        f"1. 基于原文事实提炼，严禁编造对话中未出现的信息；每条建议问题口语化、自然、不超过40字。\n"
        f"{question_rule}"
        f"3. `turnSummaries` 只针对上面列出的新发言，按语义聚合成 1~4 条简短小结（每条 <=50 字）。\n"
        f"4. Output JSON Schema:\n"
        f"{{\n"
        f'  "profile": {{\n'
        f'    "background": [{{"text": "不超过80字", "evidenceMs": 0}}],\n'
        f'    "stories": [{{"title": "短标题", "gist": "不超过80字", "evidenceMs": 0}}],\n'
        f'    "viewpoints": [{{"claim": "核心观点<=80字", "support": "论据<=80字", "evidenceMs": 0}}]'
        f"{sales_schema_hint}\n"
        f"  }},\n"
        f'  "questions": [{{"type": "{q_types.split("|")[0]}", "text": "口语化问题<=40字", "why": "提问意图<=40字", "relatedTo": "关联要点", "targetField": "可获取的目标字段名(可选)"}}],\n'
        f'  "turnSummaries": [{{"speakerId": "speakerId", "startMs": 0, "summary": "发言小结<=50字"}}],\n'
        f"{keypoints_rule}"
        f'  "outlineCoverage": [{{"id": "提纲id", "status": "covered|partial|not_started", "note": "简要依据<=40字"}}]'
        f"{target_fields_schema}\n"
        f"}}"
    )


def _clip_str(val: Any, max_len: int = 80) -> str:
    s = str(val or "").strip()
    return s[:max_len]


def normalize_live_insight(
    raw: Dict[str, Any],
    scenario: str,
    prev: Optional[Dict[str, Any]] = None,
    dismissed_texts: Optional[List[str]] = None,
    last_summarized_ms: int = -1,
    valid_speaker_ids: Optional[List[str]] = None,
    outline_items: Optional[List[Dict[str, Any]]] = None,
    target_fields: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    raw_profile = raw.get("profile") if isinstance(raw.get("profile"), dict) else {}

    bg_list = []
    for item in (raw_profile.get("background") or [])[:8]:
        if isinstance(item, dict) and str(item.get("text") or "").strip():
            bg_list.append(
                {"text": _clip_str(item.get("text"), 80), "evidenceMs": max(0, int(item.get("evidenceMs") or 0))}
            )

    stories_list = []
    for item in (raw_profile.get("stories") or [])[:8]:
        if isinstance(item, dict) and (str(item.get("title") or "").strip() or str(item.get("gist") or "").strip()):
            stories_list.append(
                {
                    "title": _clip_str(item.get("title") or "故事片段", 40),
                    "gist": _clip_str(item.get("gist"), 80),
                    "evidenceMs": max(0, int(item.get("evidenceMs") or 0)),
                }
            )

    viewpoints_list = []
    for item in (raw_profile.get("viewpoints") or [])[:8]:
        if isinstance(item, dict) and str(item.get("claim") or "").strip():
            viewpoints_list.append(
                {
                    "claim": _clip_str(item.get("claim"), 80),
                    "support": _clip_str(item.get("support"), 80),
                    "evidenceMs": max(0, int(item.get("evidenceMs") or 0)),
                }
            )

    profile: Dict[str, Any] = {
        "background": bg_list,
        "stories": stories_list,
        "viewpoints": viewpoints_list,
    }

    if scenario == "sales":
        raw_sales = raw_profile.get("sales") if isinstance(raw_profile.get("sales"), dict) else {}
        pain_points = [_clip_str(x, 80) for x in (raw_sales.get("painPoints") or [])[:8] if str(x or "").strip()]
        needs = [_clip_str(x, 80) for x in (raw_sales.get("needs") or [])[:8] if str(x or "").strip()]
        objections = []
        for obj in (raw_sales.get("objections") or [])[:8]:
            if isinstance(obj, dict) and str(obj.get("text") or "").strip():
                objections.append(
                    {
                        "text": _clip_str(obj.get("text"), 80),
                        "handled": bool(obj.get("handled")),
                        "evidenceMs": max(0, int(obj.get("evidenceMs") or 0)),
                    }
                )
        signals = []
        for sig in (raw_sales.get("decisionSignals") or [])[:8]:
            if isinstance(sig, dict) and str(sig.get("text") or "").strip():
                pol = "negative" if sig.get("polarity") == "negative" else "positive"
                signals.append(
                    {
                        "text": _clip_str(sig.get("text"), 80),
                        "polarity": pol,
                        "evidenceMs": max(0, int(sig.get("evidenceMs") or 0)),
                    }
                )
        profile["sales"] = {
            "painPoints": pain_points,
            "needs": needs,
            "objections": objections,
            "decisionSignals": signals,
        }

    allowed_q_types = (
        {"follow_up", "deepen", "pivot", "handle_objection", "advance"}
        if scenario == "sales"
        else {"follow_up", "deepen", "pivot"}
    )
    dismissed_set = {t.strip() for t in (dismissed_texts or []) if t and t.strip()}
    questions = []
    for q in raw.get("questions") or []:
        if not isinstance(q, dict):
            continue
        q_text = _clip_str(q.get("text"), 60)
        if not q_text or q_text in dismissed_set:
            continue
        q_type = str(q.get("type") or "follow_up")
        if q_type not in allowed_q_types:
            q_type = "follow_up"
        qid = "q_" + hashlib.sha1(q_text.encode("utf-8")).hexdigest()[:10]
        q_item: Dict[str, Any] = {
            "id": qid,
            "type": q_type,
            "text": q_text,
            "why": _clip_str(q.get("why"), 60),
            "relatedTo": _clip_str(q.get("relatedTo"), 40),
        }
        tf_name = _clip_str(q.get("targetField"), 30)
        if tf_name:
            q_item["targetField"] = tf_name
        questions.append(q_item)
        if len(questions) >= 4:
            break

    turn_summaries = []
    default_spk = (valid_speaker_ids[0] if valid_speaker_ids else "")
    for ts in raw.get("turnSummaries") or []:
        if not isinstance(ts, dict):
            continue
        sm = _clip_str(ts.get("summary"), 80)
        if not sm:
            continue
        st_ms = max(0, int(ts.get("startMs") or 0))
        if st_ms <= last_summarized_ms:
            continue
        spk_id = str(ts.get("speakerId") or default_spk)
        if valid_speaker_ids and spk_id not in valid_speaker_ids:
            spk_id = default_spk
        turn_summaries.append({"speakerId": spk_id, "startMs": st_ms, "summary": sm})

    key_points = [_clip_str(x, 80) for x in (raw.get("keyPoints") or [])[:8] if str(x or "").strip()]

    valid_outline_ids = {str(o.get("id")) for o in (outline_items or []) if o.get("id")}
    outline_coverage = []
    for oc in raw.get("outlineCoverage") or []:
        if not isinstance(oc, dict):
            continue
        oid = str(oc.get("id") or "")
        if valid_outline_ids and oid not in valid_outline_ids:
            continue
        st = str(oc.get("status") or "not_started")
        if st not in ("covered", "partial", "not_started"):
            st = "not_started"
        outline_coverage.append(
            {"id": oid, "status": st, "note": _clip_str(oc.get("note"), 60)}
        )

    valid_tf_ids = {str(tf.get("id")) for tf in (target_fields or []) if tf.get("id")}
    prev_tf_by_id = {
        str(tf.get("id")): tf
        for tf in ((prev or {}).get("targetFieldUpdates") or [])
        if isinstance(tf, dict) and tf.get("id")
    }
    target_field_updates = []
    seen_tf_ids = set()
    for tfu in raw.get("targetFieldUpdates") or []:
        if not isinstance(tfu, dict):
            continue
        tf_id = str(tfu.get("id") or "")
        if not tf_id or (valid_tf_ids and tf_id not in valid_tf_ids):
            continue
        st = str(tfu.get("status") or "missing")
        if st not in ("captured", "partial", "missing"):
            st = "missing"
        val = _clip_str(tfu.get("value"), 80)
        ev_ms = max(0, int(tfu.get("evidenceMs") or 0))
        prev_tf = prev_tf_by_id.get(tf_id)
        if prev_tf and prev_tf.get("status") == "captured" and st != "captured":
            target_field_updates.append(prev_tf)
        else:
            target_field_updates.append(
                {"id": tf_id, "status": st, "value": val, "evidenceMs": ev_ms}
            )
        seen_tf_ids.add(tf_id)
    for tf_id, prev_tf in prev_tf_by_id.items():
        if tf_id not in seen_tf_ids and (not valid_tf_ids or tf_id in valid_tf_ids):
            target_field_updates.append(prev_tf)

    return {
        "profile": profile,
        "questions": questions,
        "turnSummaries": turn_summaries,
        "keyPoints": key_points,
        "outlineCoverage": outline_coverage,
        "targetFieldUpdates": target_field_updates,
    }


class VolcStreamingAsr:
    """Manages Volcengine SAUC v3 WebSocket streaming ASR with reconnect and parameter fallback."""

    def __init__(
        self,
        asr_config: Dict[str, Any],
        hotwords: List[str],
        on_status: Callable[[str, Optional[str]], None],
        on_partial: Callable[[Dict[str, Any]], None],
        on_final: Callable[[Dict[str, Any]], None],
        on_error: Callable[[str, bool], None],
        get_session_ms: Callable[[], int],
    ) -> None:
        self.asr_config = dict(asr_config or {})
        self.hotwords = [str(w).strip() for w in (hotwords or []) if str(w).strip()]
        self.on_status = on_status
        self.on_partial = on_partial
        self.on_final = on_final
        self.on_error = on_error
        self.get_session_ms = get_session_ms

        self._ws_url = os.environ.get("TAPWAVE_LIVE_WS_URL") or VOLC_SAUC_WS_URL
        explicit_res = str(self.asr_config.get("volcStreamResourceId") or "").strip()
        self._resource_candidates = (
            [explicit_res] if explicit_res else list(VOLC_STREAM_RESOURCE_CANDIDATES)
        )
        self._res_idx = 0
        self._enable_speaker_params = True
        self._enable_hotwords = bool(self.hotwords)

        self._audio_q: "queue.Queue[Optional[bytes]]" = queue.Queue()
        self._backlog: Deque[bytes] = collections.deque()
        self._backlog_bytes = 0
        self._paused = False
        self._stopping = False
        self._closed = False
        self._ws: Optional[SimpleWebSocket] = None
        self._ws_lock = threading.Lock()
        self._pause_event = threading.Event()
        self._pause_event.set()
        self._finished_event = threading.Event()
        self._thread = threading.Thread(target=self._run_loop, name="VolcStreamingAsr", daemon=True)
        self._creds: Optional[Dict[str, str]] = None
        self.fatal_reason: Optional[str] = None
        self.stop_timeout_sec = 3.0

    def start(self) -> None:
        self._thread.start()

    def push_audio(self, pcm_bytes: bytes) -> None:
        if self._stopping or self._closed or self._paused or not pcm_bytes:
            return
        self._audio_q.put(pcm_bytes)

    def pause(self) -> None:
        self._paused = True
        self._pause_event.clear()
        self.on_status("paused", None)
        with self._ws_lock:
            ws = self._ws
            self._ws = None
        if ws is not None:
            try:
                ws.send_binary(build_audio_frame(b"", is_last=True))
            except Exception:
                pass
            ws.close()

    def resume(self) -> None:
        if self._stopping or self._closed:
            return
        self._paused = False
        self._pause_event.set()

    def stop(self, timeout_sec: float = 3.0) -> None:
        self._stopping = True
        self._paused = False
        self._pause_event.set()
        self._audio_q.put(None)
        self._finished_event.wait(timeout=timeout_sec)
        self._closed = True
        with self._ws_lock:
            ws = self._ws
            self._ws = None
        if ws is not None:
            ws.close()

    def _build_headers(self, resource_id: str) -> Dict[str, str]:
        if self._creds is None:
            self._creds = podcraft_ai.resolve_volcengine_speech_apikey(self.asr_config)
        headers: Dict[str, str] = {
            "X-Api-Resource-Id": resource_id,
            "X-Api-Connect-Id": str(uuid.uuid4()),
        }
        if self._creds.get("mode") == "api_key":
            headers["X-Api-Key"] = self._creds["api_key"]
        else:
            headers["X-Api-App-Key"] = self._creds.get("app_id", "")
            headers["X-Api-Access-Key"] = self._creds.get("access_token", "")
        return headers

    def _build_init_payload(self) -> Dict[str, Any]:
        uid = str(
            self.asr_config.get("volcAccountId")
            or os.environ.get("VOLC_ACCOUNT_ID")
            or "podcraft_user"
        ).strip()
        req_obj: Dict[str, Any] = {
            "model_name": "bigmodel",
            "enable_itn": True,
            "enable_punc": True,
            "show_utterances": True,
            "result_type": "single",
            "end_window_size": 800,
        }
        if self._enable_speaker_params:
            req_obj["enable_nonstream"] = True
            req_obj["enable_speaker_info"] = True
            req_obj["ssd_version"] = "200"
        if self._enable_hotwords and self.hotwords:
            req_obj["corpus"] = {
                "context": json.dumps(
                    {"hotwords": [{"word": w} for w in self.hotwords[:50]]},
                    ensure_ascii=False,
                )
            }
        return {
            "user": {"uid": uid},
            "audio": {
                "format": "pcm",
                "codec": "raw",
                "rate": LIVE_SAMPLE_RATE,
                "bits": 16,
                "channel": 1,
            },
            "request": req_obj,
        }

    def _enqueue_backlog(self, chunk: bytes) -> None:
        self._backlog.append(chunk)
        self._backlog_bytes += len(chunk)
        while self._backlog_bytes > RECONNECT_BUFFER_MAX_BYTES and self._backlog:
            dropped = self._backlog.popleft()
            self._backlog_bytes -= len(dropped)

    def _run_loop(self) -> None:
        backoff_idx = 0
        backoffs = [1.0, 2.0, 4.0, 8.0]

        if self._creds is None:
            try:
                self._creds = podcraft_ai.resolve_volcengine_speech_apikey(self.asr_config)
            except Exception as exc:
                reason = f"火山引擎凭证无效或未配置: {exc}"
                self.fatal_reason = reason
                self.on_status("error", reason)
                self.on_error(reason, True)
                self._finished_event.set()
                return

        while not self._closed:
            self._pause_event.wait()
            if self._closed or (self._stopping and self._audio_q.empty() and not self._backlog):
                break

            res_id = self._resource_candidates[min(self._res_idx, len(self._resource_candidates) - 1)]
            self.on_status("connecting" if backoff_idx == 0 else "reconnecting", None)

            try:
                headers = self._build_headers(res_id)
                ws = SimpleWebSocket.connect(self._ws_url, headers=headers, timeout=10.0)
            except WsHandshakeError as exc:
                msg = str(exc)
                if (exc.status in (401, 403) or "resource" in msg.lower() or "授权" in msg or "not granted" in msg.lower()) and (
                    self._res_idx + 1 < len(self._resource_candidates)
                ):
                    self._res_idx += 1
                    continue
                if exc.status in (401, 403) or "not granted" in msg.lower():
                    reason = f"火山引擎流式语音鉴权/资源失败: {msg}"
                    self.fatal_reason = reason
                    self.on_status("error", reason)
                    self.on_error(reason, True)
                    break
                self.on_status("reconnecting", msg)
                time.sleep(backoffs[min(backoff_idx, len(backoffs) - 1)])
                backoff_idx += 1
                continue
            except Exception as exc:
                self.on_status("reconnecting", str(exc))
                if self._stopping:
                    break
                time.sleep(backoffs[min(backoff_idx, len(backoffs) - 1)])
                backoff_idx += 1
                continue

            conn_offset_ms = self.get_session_ms()
            tracker = UtteranceTracker(offset_ms=conn_offset_ms)
            with self._ws_lock:
                self._ws = ws

            try:
                ws.send_binary(build_full_client_request(self._build_init_payload()))
            except Exception as exc:
                ws.close()
                self.on_status("reconnecting", str(exc))
                time.sleep(backoffs[min(backoff_idx, len(backoffs) - 1)])
                backoff_idx += 1
                continue

            backoff_idx = 0
            self.on_status("connected", None)

            # Flush buffered audio from reconnect window
            while self._backlog:
                chunk = self._backlog.popleft()
                self._backlog_bytes -= len(chunk)
                try:
                    ws.send_binary(build_audio_frame(chunk, is_last=False))
                except Exception:
                    self._enqueue_backlog(chunk)
                    break

            param_rejected = threading.Event()
            recv_done = threading.Event()
            got_valid_response = threading.Event()

            def _recv_worker() -> None:
                try:
                    while not self._closed:
                        _op, data = ws.recv()
                        frame = parse_volc_frame(data)
                        if frame["kind"] == "error":
                            err_msg = str(frame.get("message") or "")
                            err_code = frame.get("code")
                            if not got_valid_response.is_set() and (
                                self._enable_speaker_params or self._enable_hotwords
                            ):
                                param_rejected.set()
                                self.on_status(
                                    "reconnecting",
                                    f"流式参数不兼容({err_code})，自动降级重连: {err_msg}",
                                )
                            else:
                                self.on_status("error", f"ASR 错误 ({err_code}): {err_msg}")
                            break

                        if frame["kind"] == "response":
                            got_valid_response.set()
                            finals, partial = tracker.process_payload(frame.get("payload") or {})
                            for fin in finals:
                                self.on_final(fin)
                            if partial is not None:
                                self.on_partial(partial)
                            if frame.get("isLast"):
                                break
                except WsClosed:
                    pass
                except Exception as exc:
                    if not self._paused and not self._stopping and not self._closed:
                        self.on_status("reconnecting", str(exc))
                finally:
                    recv_done.set()

            recv_thread = threading.Thread(target=_recv_worker, name="VolcAsrRecv", daemon=True)
            recv_thread.start()

            while not self._closed and not self._paused and not recv_done.is_set():
                try:
                    item = self._audio_q.get(timeout=0.1)
                except queue.Empty:
                    if self._stopping:
                        break
                    continue

                if item is None:
                    try:
                        ws.send_binary(build_audio_frame(b"", is_last=True))
                    except Exception:
                        pass
                    break

                try:
                    ws.send_binary(build_audio_frame(item, is_last=False))
                except Exception:
                    self._enqueue_backlog(item)
                    break

            if self._stopping:
                recv_done.wait(timeout=2.5)
                break

            recv_done.wait(timeout=0.5)
            with self._ws_lock:
                if self._ws is ws:
                    self._ws = None
            ws.close()

            if param_rejected.is_set():
                self._enable_speaker_params = False
                self._enable_hotwords = False
                continue

            if not self._paused and not self._closed and not self._stopping:
                time.sleep(backoffs[min(backoff_idx, len(backoffs) - 1)])
                backoff_idx += 1

        self._finished_event.set()


def _has_volcengine_credentials(asr_config: Dict[str, Any]) -> bool:
    if str(asr_config.get("volcApiKey") or os.environ.get("VOLC_API_KEY") or "").strip():
        return True
    app_id = str(asr_config.get("volcAppId") or os.environ.get("VOLC_APP_ID") or "").strip()
    token = str(asr_config.get("volcAccessToken") or os.environ.get("VOLC_ACCESS_TOKEN") or "").strip()
    if app_id and token:
        return True
    ak = str(asr_config.get("volcAccessKeyId") or os.environ.get("VOLC_ACCESS_KEY_ID") or "").strip()
    sk = str(asr_config.get("volcSecretAccessKey") or os.environ.get("VOLC_SECRET_ACCESS_KEY") or "").strip()
    return bool(ak and sk)


class LocalStreamingAsr:
    """Near-real-time offline ASR using Silero VAD + SenseVoice/Paraformer (sherpa-onnx)."""

    def __init__(
        self,
        asr_config: Dict[str, Any],
        hotwords: List[str],
        on_status: Callable[[str, Optional[str]], None],
        on_partial: Callable[[Dict[str, Any]], None],
        on_final: Callable[[Dict[str, Any]], None],
        on_error: Callable[[str, bool], None],
        get_session_ms: Callable[[], int],
        prefill_pcm: Optional[np.ndarray] = None,
        base_ms: int = 0,
    ) -> None:
        self.asr_config = dict(asr_config or {})
        self.hotwords = [str(w).strip() for w in (hotwords or []) if str(w).strip()]
        self.on_status = on_status
        self.on_partial = on_partial
        self.on_final = on_final
        self.on_error = on_error
        self.get_session_ms = get_session_ms
        self._prefill_pcm = prefill_pcm
        self._base_ms = max(0, int(base_ms))
        self.stop_timeout_sec = 5.0
        self.fatal_reason: Optional[str] = None

        self._q: "queue.Queue[Optional[Tuple[str, Any]]]" = queue.Queue()
        self._paused = False
        self._stopping = False
        self._finished = threading.Event()
        self._thread = threading.Thread(target=self._run_loop, name="LocalStreamingAsr", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def push_audio(self, pcm_bytes: bytes) -> None:
        if self._stopping or self._paused or not pcm_bytes:
            return
        self._q.put(("audio", pcm_bytes))

    def pause(self) -> None:
        if self._stopping or self._paused:
            return
        self._paused = True
        self._q.put(("pause", None))

    def resume(self) -> None:
        if self._stopping or not self._paused:
            return
        self._paused = False
        self._q.put(("resume", None))

    def stop(self, timeout_sec: float = 5.0) -> None:
        self._stopping = True
        self._paused = False
        self._q.put(None)
        self._finished.wait(timeout=timeout_sec)

    def _decode_samples(self, rec: Any, punct: Any, samples_f32: np.ndarray) -> str:
        if samples_f32.size < 1600:
            return ""
        stream = rec.create_stream()
        stream.accept_waveform(LIVE_SAMPLE_RATE, samples_f32)
        rec.decode_stream(stream)
        text = str(getattr(stream.result, "text", "") or "").strip()
        if punct is not None and text:
            try:
                text = str(punct.add_punctuation(text) or text).strip()
            except Exception:
                pass
        return text

    def _drain_vad_finals(
        self, vad: Any, rec: Any, punct: Any, vad_base_samples: int
    ) -> None:
        while not vad.empty():
            seg = vad.front
            seg_start = int(seg.start)
            seg_samples = np.array(seg.samples, dtype=np.float32)
            vad.pop()
            text = self._decode_samples(rec, punct, seg_samples)
            if text:
                start_samples = vad_base_samples + seg_start
                end_samples = start_samples + int(seg_samples.size)
                self.on_final(
                    {
                        "text": text,
                        "startMs": int(start_samples * 1000 // LIVE_SAMPLE_RATE),
                        "endMs": int(end_samples * 1000 // LIVE_SAMPLE_RATE),
                        "cloudSpeakerId": None,
                    }
                )

    def _run_loop(self) -> None:
        self.on_status("connecting", "正在加载本地离线语音模型...")
        try:
            import sherpa_onnx  # type: ignore

            if not os.path.isfile(podcraft_ai.SILERO_VAD_PATH):
                raise RuntimeError("未找到 silero_vad.onnx")
            rec, punct, _engine_name = podcraft_ai.build_local_sherpa_recognizer()

            vad_cfg = sherpa_onnx.VadModelConfig()
            vad_cfg.silero_vad.model = podcraft_ai.SILERO_VAD_PATH
            vad_cfg.silero_vad.threshold = 0.35
            vad_cfg.silero_vad.min_silence_duration = 0.4
            vad_cfg.silero_vad.min_speech_duration = 0.16
            vad_cfg.silero_vad.max_speech_duration = 15.0
            vad_cfg.silero_vad.window_size = 512
            vad_cfg.sample_rate = LIVE_SAMPLE_RATE
            vad = sherpa_onnx.VoiceActivityDetector(vad_cfg, buffer_size_in_seconds=60)
        except Exception:
            reason = "本地语音识别模型缺失（需要 SenseVoice/Paraformer + silero_vad.onnx），请在依赖向导中下载"
            self.fatal_reason = reason
            self.on_status("error", reason)
            self.on_error(reason, True)
            self._finished.set()
            return

        self.on_status("connected", None)

        vad_base_samples = int(self._base_ms * LIVE_SAMPLE_RATE // 1000)
        leftover = np.zeros(0, dtype=np.float32)
        last_partial_at = 0.0
        last_partial_text = ""

        def _feed_float32(samples_f32: np.ndarray) -> None:
            nonlocal leftover, last_partial_at, last_partial_text
            if samples_f32.size == 0:
                return
            buf = np.concatenate([leftover, samples_f32]) if leftover.size else samples_f32
            win = 512
            usable = (int(buf.size) // win) * win
            for idx in range(0, usable, win):
                vad.accept_waveform(buf[idx : idx + win])
            leftover = buf[usable:]
            self._drain_vad_finals(vad, rec, punct, vad_base_samples)

            now = time.monotonic()
            if (now - last_partial_at) >= 0.35:
                cur_seg = getattr(vad, "current_segment", None)
                if cur_seg is not None:
                    cur_samples = np.asarray(getattr(cur_seg, "samples", []) or [], dtype=np.float32)
                    if cur_samples.size >= int(0.32 * LIVE_SAMPLE_RATE):
                        tail = cur_samples[-10 * LIVE_SAMPLE_RATE :]
                        p_text = self._decode_samples(rec, punct, tail)
                        if p_text and p_text != last_partial_text:
                            last_partial_text = p_text
                            st_samp = vad_base_samples + int(getattr(cur_seg, "start", 0))
                            en_samp = st_samp + int(cur_samples.size)
                            self.on_partial(
                                {
                                    "text": p_text,
                                    "startMs": int(st_samp * 1000 // LIVE_SAMPLE_RATE),
                                    "endMs": int(en_samp * 1000 // LIVE_SAMPLE_RATE),
                                    "cloudSpeakerId": None,
                                }
                            )
                        last_partial_at = now

        if self._prefill_pcm is not None and self._prefill_pcm.size > 0:
            _feed_float32(self._prefill_pcm.astype(np.float32) / 32768.0)

        while True:
            item = self._q.get()
            if item is None:
                if leftover.size > 0:
                    padded = np.pad(leftover, (0, 512 - int(leftover.size)))
                    vad.accept_waveform(padded)
                    leftover = np.zeros(0, dtype=np.float32)
                vad.flush()
                self._drain_vad_finals(vad, rec, punct, vad_base_samples)
                break

            kind, val = item
            if kind == "audio":
                arr = np.frombuffer(val, dtype="<i2").astype(np.float32) / 32768.0
                _feed_float32(arr)
            elif kind == "pause":
                vad.flush()
                self._drain_vad_finals(vad, rec, punct, vad_base_samples)
                leftover = np.zeros(0, dtype=np.float32)
                last_partial_text = ""
                self.on_status("paused", None)
            elif kind == "resume":
                vad.reset()
                leftover = np.zeros(0, dtype=np.float32)
                last_partial_text = ""
                vad_base_samples = int(self.get_session_ms() * LIVE_SAMPLE_RATE // 1000)
                self.on_status("connected", None)

        self._finished.set()


class AsrRouter:
    """Routes live audio to Volcengine streaming ASR or LocalStreamingAsr, with auto fallback."""

    def __init__(
        self,
        mode: str,
        asr_config: Dict[str, Any],
        hotwords: List[str],
        ring: AudioRingBuffer,
        on_status: Callable[[str, Optional[str]], None],
        on_partial: Callable[[Dict[str, Any]], None],
        on_final: Callable[[Dict[str, Any]], None],
        on_error: Callable[[str, bool], None],
        on_engine_switch: Callable[[str, str], None],
    ) -> None:
        self.mode = mode if mode in ("auto", "volcengine", "local") else "auto"
        self.asr_config = dict(asr_config or {})
        self.hotwords = list(hotwords or [])
        self.ring = ring
        self.on_status = on_status
        self.on_partial = on_partial
        self.on_final = on_final
        self.on_error = on_error
        self.on_engine_switch = on_engine_switch

        self._lock = threading.Lock()
        self._switched = False

        if self.mode == "local":
            self._use_local = True
        elif self.mode == "volcengine":
            self._use_local = False
        else:
            self._use_local = not _has_volcengine_credentials(self.asr_config)

        if self._use_local:
            self.initial_engine_name = "local_sensevoice"
            self._active: Any = LocalStreamingAsr(
                asr_config=self.asr_config,
                hotwords=self.hotwords,
                on_status=self.on_status,
                on_partial=self.on_partial,
                on_final=self.on_final,
                on_error=self.on_error,
                get_session_ms=lambda: self.ring.total_ms,
            )
        else:
            self.initial_engine_name = "volcengine_sauc_bigmodel"
            self._active = VolcStreamingAsr(
                asr_config=self.asr_config,
                hotwords=self.hotwords,
                on_status=self._wrap_volc_status,
                on_partial=self.on_partial,
                on_final=self.on_final,
                on_error=self._wrap_volc_error,
                get_session_ms=lambda: self.ring.total_ms,
            )

    def _wrap_volc_status(self, st: str, msg: Optional[str]) -> None:
        if self.mode == "auto" and st == "error":
            return
        self.on_status(st, msg)

    def _wrap_volc_error(self, msg: str, fatal: bool) -> None:
        if not fatal or self.mode != "auto":
            self.on_error(msg, fatal)
            return

        with self._lock:
            if self._switched:
                return
            self._switched = True

        self.on_engine_switch("local_sensevoice", msg)
        self.on_error(f"火山流式识别不可用，已自动切换到本地离线识别：{msg}", False)

        total_ms = self.ring.total_ms
        base_ms = max(0, total_ms - 170000) if total_ms > 180000 else 0
        prefill = self.ring.slice_int16(base_ms, total_ms)
        local_asr = LocalStreamingAsr(
            asr_config=self.asr_config,
            hotwords=self.hotwords,
            on_status=self.on_status,
            on_partial=self.on_partial,
            on_final=self.on_final,
            on_error=self.on_error,
            get_session_ms=lambda: self.ring.total_ms,
            prefill_pcm=prefill,
            base_ms=base_ms,
        )
        with self._lock:
            self._active = local_asr
        local_asr.start()

    def start(self) -> None:
        with self._lock:
            eng = self._active
        eng.start()

    def push_audio(self, pcm_bytes: bytes) -> None:
        with self._lock:
            eng = self._active
        eng.push_audio(pcm_bytes)

    def pause(self) -> None:
        with self._lock:
            eng = self._active
        eng.pause()

    def resume(self) -> None:
        with self._lock:
            eng = self._active
        eng.resume()

    def stop(self) -> None:
        with self._lock:
            eng = self._active
        eng.stop(timeout_sec=getattr(eng, "stop_timeout_sec", 3.0))


class LiveCopilot:
    """Single-flight background LLM copilot generating profile, questions, summaries & outline coverage."""

    def __init__(
        self,
        scenario: str,
        prep: Dict[str, Any],
        speakers: List[Dict[str, Any]],
        llm_config: Dict[str, Any],
        on_status: Callable[[str, Optional[str]], None],
        on_insight: Callable[[Dict[str, Any]], None],
        on_request: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.scenario = scenario if scenario in SCENARIO_SYSTEM_PROMPTS else "interview"
        self.prep = dict(prep or {})
        self.speakers = list(speakers or [])
        self.llm_config = dict(llm_config or {})
        self.on_status = on_status
        self.on_insight = on_insight
        self.on_request = on_request

        self.enabled = (
            not self.llm_config.get("forceLocalOnly")
            and self.llm_config.get("provider") != "local_only"
            and bool(str(self.llm_config.get("apiKey") or "").strip())
        )
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._pending = False
        self._stopping = False
        self._in_flight = False
        self._seq = 0
        self._last_trigger_sec = 0.0
        self._chars_since_last = 0
        self._counterpart_turn_chars = 0
        self._last_speaker_role: Optional[str] = None
        self._last_summarized_ms = -1
        self._utterances: List[Dict[str, Any]] = []
        self._prev_insight: Dict[str, Any] = {
            "profile": {"background": [], "stories": [], "viewpoints": []},
            "questions": [],
            "turnSummaries": [],
            "keyPoints": [],
            "outlineCoverage": [],
        }
        self._adopted_questions: List[str] = []
        self._dismissed_questions: List[str] = []
        self._outline_overrides: Dict[str, str] = {}
        self._thread = threading.Thread(target=self._worker_loop, name="LiveCopilot", daemon=True)

    def start(self) -> None:
        if not self.enabled:
            self.on_status("disabled", "未配置大模型 API Key，仅执行实时转写")
            return
        self.on_status("idle", None)
        self._thread.start()

    def on_final_utterance(self, utt: Dict[str, Any]) -> None:
        speaker_map = {str(s["id"]): s for s in self.speakers}
        role = str((speaker_map.get(str(utt.get("speakerId"))) or {}).get("role") or "counterpart")
        text_len = len(str(utt.get("text") or ""))

        with self._cond:
            self._utterances.append(dict(utt))
            self._chars_since_last += text_len
            counterpart_ended = 0
            if role == "counterpart":
                self._counterpart_turn_chars += text_len
            elif role == "self" and self._last_speaker_role == "counterpart":
                counterpart_ended = self._counterpart_turn_chars
                self._counterpart_turn_chars = 0
            self._last_speaker_role = role

            if self.enabled and should_trigger_insight(
                time.monotonic(),
                self._last_trigger_sec,
                self._chars_since_last,
                counterpart_ended,
                manual=False,
            ):
                self._pending = True
                self._cond.notify()

    def update_utterance_speaker(self, utterance_id: str, speaker_id: str) -> None:
        with self._lock:
            for u in self._utterances:
                if u.get("id") == utterance_id:
                    u["speakerId"] = speaker_id
                    break

    def update_utterance_text(self, utterance_id: str, new_text: str) -> None:
        with self._lock:
            for u in self._utterances:
                if u.get("id") == utterance_id:
                    u["text"] = new_text
                    break

    def add_speaker(self, speaker: Dict[str, Any]) -> None:
        sid = str(speaker.get("id") or "")
        if not sid:
            return
        with self._lock:
            if any(str(s.get("id")) == sid for s in self.speakers):
                return
            self.speakers.append(dict(speaker))

    def trigger_manual(self) -> None:
        if not self.enabled:
            return
        with self._cond:
            if self._utterances:
                self._pending = True
                self._cond.notify()

    def record_question_feedback(self, question_id: str, action: str) -> None:
        with self._lock:
            q_text = ""
            for q in self._prev_insight.get("questions") or []:
                if q.get("id") == question_id:
                    q_text = str(q.get("text") or "")
                    break
            if not q_text:
                return
            if action == "adopted" and q_text not in self._adopted_questions:
                self._adopted_questions.append(q_text)
            elif action == "dismissed" and q_text not in self._dismissed_questions:
                self._dismissed_questions.append(q_text)

    def set_outline_override(self, item_id: str, status: str) -> None:
        with self._lock:
            self._outline_overrides[item_id] = status

    def wait_current_and_stop(self, timeout_sec: float = 25.0) -> None:
        with self._cond:
            self._stopping = True
            self._pending = False
            self._cond.notify_all()
        if self._thread.is_alive():
            self._thread.join(timeout=timeout_sec)

    def _run_once(self) -> None:
        with self._lock:
            utterances_snap = [dict(u) for u in self._utterances]
            if not utterances_snap:
                return
            based_on_id = str(utterances_snap[-1].get("id") or "")
            last_sum_ms = self._last_summarized_ms
            ctx = {
                "scenario": self.scenario,
                "prep": self.prep,
                "speakers": self.speakers,
                "utterances": utterances_snap,
                "lastSummarizedMs": last_sum_ms,
                "prevInsight": self._prev_insight,
                "adoptedQuestions": list(self._adopted_questions),
                "dismissedQuestions": list(self._dismissed_questions),
            }
            self._last_trigger_sec = time.monotonic()
            self._chars_since_last = 0

        if self.on_request is not None:
            self.on_request(based_on_id)
        self.on_status("thinking", None)
        try:
            prompt = build_live_insight_prompt(ctx)
            sys_prompt = SCENARIO_SYSTEM_PROMPTS.get(self.scenario, SCENARIO_SYSTEM_PROMPTS["interview"])
            raw_text = podcraft_ai.call_cloud_llm(
                prompt,
                self.llm_config,
                system_prompt=sys_prompt,
                timeout=25,
                temperature=0.2,
            )
            parsed = _extract_json_obj(raw_text)
            norm = normalize_live_insight(
                parsed,
                scenario=self.scenario,
                prev=self._prev_insight,
                dismissed_texts=self._dismissed_questions,
                last_summarized_ms=last_sum_ms,
                valid_speaker_ids=[str(s["id"]) for s in self.speakers],
                outline_items=self.prep.get("outline") or [],
                target_fields=self.prep.get("targetFields") or [],
            )
            with self._lock:
                self._seq += 1
                seq = self._seq
                if norm["turnSummaries"]:
                    self._last_summarized_ms = max(
                        self._last_summarized_ms,
                        max(int(ts["startMs"]) for ts in norm["turnSummaries"]),
                    )
                for oc in norm["outlineCoverage"]:
                    if oc["id"] in self._outline_overrides:
                        oc["status"] = self._outline_overrides[oc["id"]]
                self._prev_insight = norm
            self.on_status("idle", None)
            self.on_insight(
                {
                    "seq": seq,
                    **norm,
                    "basedOnUtteranceId": based_on_id,
                    "generatedAt": int(time.time() * 1000),
                }
            )
        except Exception as exc:
            self.on_status("error", f"AI 洞察生成失败: {exc}")

    def _worker_loop(self) -> None:
        while True:
            with self._cond:
                while not self._pending and not self._stopping:
                    # Periodic 60s check
                    self._cond.wait(timeout=15.0)
                    if self._stopping:
                        break
                    if (
                        not self._pending
                        and self.enabled
                        and should_trigger_insight(
                            time.monotonic(),
                            self._last_trigger_sec,
                            self._chars_since_last,
                            0,
                            manual=False,
                        )
                    ):
                        self._pending = True
                if self._stopping and not self._pending:
                    break
                self._pending = False
                self._in_flight = True

            try:
                self._run_once()
            finally:
                with self._cond:
                    self._in_flight = False
                    if self._stopping:
                        break

    def generate_final_summary(self, timeout_sec: float = 30.0) -> Optional[Dict[str, Any]]:
        if not self.enabled:
            return None
        with self._lock:
            utterances_snap = [dict(u) for u in self._utterances]
            if not utterances_snap:
                return None
            speaker_by_id = {str(s["id"]): s for s in self.speakers}
            lines = [
                f"[{_format_mm_ss(int(u.get('startMs') or 0))}] {speaker_by_id.get(str(u.get('speakerId')), {}).get('name', '发言人')}: {u.get('text', '')}"
                for u in utterances_snap
            ]
            context_txt = "\n".join(lines[-120:])[:10000]
            key_points = list(self._prev_insight.get("keyPoints") or [])

        is_listen = self.scenario == "listen"
        summary_intro = (
            "请基于以下完整演讲/分享文字稿和已提炼要点，主要聚焦主讲人的核心内容与有效 Q&A 回答（自动过滤旁听人员的私下讨论与闲聊），生成最终演讲总结与收获笔记，严格输出合法 JSON：\n"
            if is_listen
            else f"请基于以下完整{self.scenario}对话记录和已提炼要点，生成最终会议总结，严格输出合法 JSON：\n"
        )
        next_step_hint = (
            '"nextSteps": ["延伸思考或可落地实践1"]'
            if is_listen
            else '"nextSteps": ["后续行动1"]'
        )
        prompt = (
            f"{summary_intro}"
            f"已有要点: {json.dumps(key_points, ensure_ascii=False)}\n\n"
            f"内容记录:\n{context_txt}\n\n"
            f"输出 JSON 格式：\n"
            f'{{"overview": "150~250字全场总结", "keyTakeaways": ["关键结论1", "关键结论2"], {next_step_hint}}}'
        )
        try:
            raw_text = podcraft_ai.call_cloud_llm(
                prompt,
                self.llm_config,
                system_prompt="你是一位专业对话总结编辑，请严格输出合法 JSON。",
                timeout=timeout_sec,
                temperature=0.2,
            )
            obj = _extract_json_obj(raw_text)
            overview = str(obj.get("overview") or "").strip()
            takeaways = [str(x).strip() for x in (obj.get("keyTakeaways") or []) if str(x).strip()][:8]
            next_steps = [str(x).strip() for x in (obj.get("nextSteps") or []) if str(x).strip()][:6]
            if not overview and not takeaways:
                return None
            return {
                "overview": overview,
                "keyTakeaways": takeaways,
                "nextSteps": next_steps,
            }
        except Exception:
            return None


def stream_cloud_llm(
    prompt: str,
    llm_config: Dict[str, Any],
    system_prompt: str = "",
    timeout: float = 20.0,
) -> Iterator[str]:
    """Stream text chunks from Gemini or OpenAI-compatible (DeepSeek/OpenAI) SSE endpoints."""
    provider = str(llm_config.get("provider") or "deepseek").strip()
    api_key = str(llm_config.get("apiKey") or "").strip()
    if not api_key:
        return

    if provider == "gemini":
        model = str(llm_config.get("model") or "gemini-2.5-flash").strip()
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model}:streamGenerateContent?alt=sse&key={api_key}"
        )
        full_prompt = f"{system_prompt}\n\n{prompt}" if system_prompt else prompt
        payload: Dict[str, Any] = {
            "contents": [{"parts": [{"text": full_prompt}]}],
            "generationConfig": {"temperature": 0.1},
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            for raw_line in resp:
                line = raw_line.decode("utf-8", errors="ignore").strip()
                if not line.startswith("data:"):
                    continue
                data_str = line[5:].strip()
                if not data_str or data_str == "[DONE]":
                    continue
                try:
                    chunk_obj = json.loads(data_str)
                    candidates = chunk_obj.get("candidates") or []
                    if candidates:
                        parts = (candidates[0].get("content") or {}).get("parts") or []
                        for part in parts:
                            txt = part.get("text")
                            if txt:
                                yield str(txt)
                except Exception:
                    continue
        return

    default_base = (
        "https://api.deepseek.com/v1"
        if provider == "deepseek"
        else "https://api.openai.com/v1"
    )
    default_model = "deepseek-chat" if provider == "deepseek" else "gpt-4o-mini"
    base_url = str(llm_config.get("baseUrl") or default_base).rstrip("/")
    model = str(llm_config.get("model") or default_model).strip()
    url = f"{base_url}/chat/completions"
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": 0.1,
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
        for raw_line in resp:
            line = raw_line.decode("utf-8", errors="ignore").strip()
            if not line.startswith("data:"):
                continue
            data_str = line[5:].strip()
            if not data_str or data_str == "[DONE]":
                break
            try:
                chunk_obj = json.loads(data_str)
                choices = chunk_obj.get("choices") or []
                if choices:
                    delta = choices[0].get("delta") or {}
                    content = delta.get("content")
                    if content:
                        yield str(content)
            except Exception:
                continue


class LiveTranscriptCorrector:
    """
    Background streaming LLM corrector that refines fast local ASR utterances
    (fixing homophones, technical terms/hotwords, and punctuation) without blocking live display.
    """

    def __init__(
        self,
        llm_config: Dict[str, Any],
        topic: str,
        hotwords: List[str],
        enabled: bool,
        on_correction: Callable[[str, str, str, str], None],
    ) -> None:
        self.llm_config = dict(llm_config or {})
        self.topic = str(topic or "").strip()
        self.hotwords = [str(w).strip() for w in (hotwords or []) if str(w).strip()]
        self.has_key = (
            not self.llm_config.get("forceLocalOnly")
            and self.llm_config.get("provider") != "local_only"
            and bool(str(self.llm_config.get("apiKey") or "").strip())
        )
        self.enabled = bool(enabled and self.has_key)
        self.on_correction = on_correction
        self._queue: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()
        self._context_history: Deque[str] = collections.deque(maxlen=4)
        self._stopping = False
        self._thread = threading.Thread(
            target=self._worker_loop, name="LiveTranscriptCorrector", daemon=True
        )

    def start(self) -> None:
        if self.enabled:
            self._thread.start()

    def enqueue(self, utt: Dict[str, Any]) -> None:
        if not self.enabled or self._stopping:
            return
        text = str(utt.get("text") or "").strip()
        if len(text) < 2:
            return
        self._queue.put(dict(utt))

    def stop(self, timeout_sec: float = 4.0) -> None:
        self._stopping = True
        if self.enabled:
            self._queue.put(None)
            if self._thread.is_alive():
                self._thread.join(timeout=timeout_sec)

    def _build_prompt(self, raw_text: str) -> Tuple[str, str]:
        system_prompt = (
            "你是实时语音识别流式纠错助手。任务：结合上下文和专有词库，修正语音识别文本中的同音错字、"
            "英文/专有名词拼写和断句标点。规则：1) 仅输出纠正后的纯文本，不要任何解释、引号或前缀；"
            "2) 严禁改变原意、严禁扩写或删减说话内容；3) 如果原句已准确，请原样输出。"
        )
        parts: List[str] = []
        if self.topic:
            parts.append(f"对话主题：{self.topic}")
        if self.hotwords:
            parts.append(f"参考专有名词/热词：{', '.join(self.hotwords[:30])}")
        if self._context_history:
            parts.append("前文上下文：\n" + "\n".join(self._context_history))
        parts.append(f"待纠正识别句：{raw_text}")
        return system_prompt, "\n\n".join(parts)

    def _clean_output(self, text: str) -> str:
        cleaned = text.strip()
        if len(cleaned) >= 2 and (
            (cleaned.startswith("“") and cleaned.endswith("”"))
            or (cleaned.startswith('"') and cleaned.endswith('"'))
        ):
            cleaned = cleaned[1:-1].strip()
        return cleaned

    def _correct_one(self, utt: Dict[str, Any]) -> None:
        uid = str(utt.get("id") or "")
        raw_text = str(utt.get("text") or "").strip()
        if not uid or not raw_text:
            return
        system_prompt, prompt = self._build_prompt(raw_text)
        acc = ""
        last_emit_ts = 0.0
        try:
            for chunk in stream_cloud_llm(
                prompt, self.llm_config, system_prompt=system_prompt, timeout=18.0
            ):
                acc += chunk
                now = time.monotonic()
                if now - last_emit_ts >= 0.06:
                    preview = self._clean_output(acc)
                    if preview:
                        self.on_correction(uid, "streaming", preview, raw_text)
                        last_emit_ts = now

            final_text = self._clean_output(acc)
            # Sanity guard against empty output or hallucinated expansion
            if (
                not final_text
                or final_text == raw_text
                or len(final_text) > max(len(raw_text) * 2.2, len(raw_text) + 25)
                or len(final_text) < len(raw_text) * 0.35
            ):
                self._context_history.append(raw_text)
                self.on_correction(uid, "unchanged", raw_text, raw_text)
            else:
                self._context_history.append(final_text)
                self.on_correction(uid, "done", final_text, raw_text)
        except Exception:
            self._context_history.append(raw_text)
            self.on_correction(uid, "unchanged", raw_text, raw_text)

    def _worker_loop(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                break
            if self._stopping and self._queue.qsize() > 3:
                # Drain quickly on stop
                continue
            self._correct_one(item)


def _atomic_write_json(path: str, data: Dict[str, Any]) -> None:
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


def run_live_session() -> None:
    """Main entry point for `python -u podcraft_ai.py live`."""
    podcraft_ai.load_dotenv_local()
    emit_lock = threading.Lock()

    def emit(event: Dict[str, Any]) -> None:
        line = json.dumps(event, ensure_ascii=False)
        with emit_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    first_line = sys.stdin.readline()
    if not first_line:
        emit({"type": "error", "message": "未收到 start 初始化指令", "fatal": True})
        return
    try:
        start_cmd = json.loads(first_line)
    except Exception as exc:
        emit({"type": "error", "message": f"start JSON 解析失败: {exc}", "fatal": True})
        return

    if start_cmd.get("type") != "start":
        emit({"type": "error", "message": "首行指令必须为 start", "fatal": True})
        return

    session_id = str(start_cmd.get("sessionId") or uuid.uuid4().hex[:12])
    output_dir = str(start_cmd.get("outputDir") or "").strip()
    if not output_dir:
        output_dir = os.path.join(
            os.path.expanduser("~"),
            "TapWave Recordings",
            time.strftime("%Y%m%d-%H%M%S"),
        )
    os.makedirs(output_dir, exist_ok=True)
    wav_path = os.path.join(output_dir, "recording.wav")
    session_json_path = os.path.join(output_dir, "session.json")

    scenario = str(start_cmd.get("scenario") or "interview")
    title = str(start_cmd.get("title") or "未命名录制")
    prep = start_cmd.get("prep") or {}
    speakers = start_cmd.get("speakers") or []
    first_speaker_id = start_cmd.get("firstSpeakerId")
    asr_config = start_cmd.get("asrConfig") or {}
    hotwords = start_cmd.get("hotwords") or []
    llm_cfg = podcraft_ai.resolve_effective_llm_config(
        {"llmConfig": start_cmd.get("llmConfig") or {}, "asrConfig": asr_config}
    )
    correction_llm_cfg = podcraft_ai.resolve_effective_llm_config(
        {
            "llmConfig": start_cmd.get("correctionLlmConfig")
            or start_cmd.get("llmConfig")
            or {},
            "asrConfig": asr_config,
        }
    )
    enable_stream_correction = bool(start_cmd.get("enableStreamCorrection", True))

    wav_file = wave.open(wav_path, "wb")
    wav_file.setnchannels(1)
    wav_file.setsampwidth(2)
    wav_file.setframerate(LIVE_SAMPLE_RATE)
    wav_lock = threading.Lock()

    state_lock = threading.Lock()
    utterances: List[Dict[str, Any]] = []
    latest_insight: Optional[Dict[str, Any]] = None
    final_summary: Optional[Dict[str, Any]] = None
    utt_counter = 0

    resolver = SpeakerResolver(speakers=speakers, first_speaker_id=first_speaker_id)

    def _build_session_doc() -> Dict[str, Any]:
        with state_lock:
            return {
                "sessionId": session_id,
                "scenario": scenario,
                "title": title,
                "prep": prep,
                "speakers": resolver.speakers,
                "utterances": list(utterances),
                "latestInsight": latest_insight,
                "finalSummary": final_summary,
                "durationMs": resolver.ring.total_ms,
                "wavPath": wav_path,
                "updatedAt": int(time.time() * 1000),
            }

    def _on_asr_status(asr_status: str, msg: Optional[str]) -> None:
        ev: Dict[str, Any] = {"type": "status", "asr": asr_status}
        if msg:
            ev["message"] = msg
        emit(ev)

    def _on_llm_status(llm_status: str, msg: Optional[str]) -> None:
        ev: Dict[str, Any] = {"type": "status", "llm": llm_status}
        if msg:
            ev["message"] = msg
        emit(ev)

    def _on_insight(insight_obj: Dict[str, Any]) -> None:
        nonlocal latest_insight
        with state_lock:
            latest_insight = insight_obj
        emit({"type": "insight", **insight_obj})

    copilot = LiveCopilot(
        scenario=scenario,
        prep=prep,
        speakers=resolver.speakers,
        llm_config=llm_cfg,
        on_status=_on_llm_status,
        on_insight=_on_insight,
        on_request=lambda uid: emit({"type": "insight_request", "upToUtteranceId": uid}),
    )

    def _on_correction(uid: str, status: str, corrected_text: str, raw_text: str) -> None:
        if status == "done":
            with state_lock:
                for u in utterances:
                    if u.get("id") == uid:
                        u["rawText"] = raw_text
                        u["text"] = corrected_text
                        break
            copilot.update_utterance_text(uid, corrected_text)
        emit(
            {
                "type": "utterance_correction",
                "utteranceId": uid,
                "status": status,
                "correctedText": corrected_text,
                "rawText": raw_text,
            }
        )

    corrector = LiveTranscriptCorrector(
        llm_config=correction_llm_cfg,
        topic=str(prep.get("topic") or title),
        hotwords=hotwords,
        enabled=enable_stream_correction,
        on_correction=_on_correction,
    )

    def _on_partial(p: Dict[str, Any]) -> None:
        spk_id = resolver.preview_speaker_for_cloud(p.get("cloudSpeakerId"))
        ev: Dict[str, Any] = {
            "type": "partial",
            "text": p["text"],
            "startMs": p["startMs"],
            "endMs": p["endMs"],
        }
        if spk_id:
            ev["speakerId"] = spk_id
        emit(ev)

    def _on_final(f: Dict[str, Any]) -> None:
        nonlocal utt_counter
        with state_lock:
            utt_counter += 1
            uid = f"u_{utt_counter}"
        spk_id, label, source = resolver.resolve(
            uid,
            int(f["startMs"]),
            int(f["endMs"]),
            cloud_speaker_id=f.get("cloudSpeakerId"),
        )
        vp_meta = resolver.get_utterance_voiceprint(uid)
        utt_obj = {
            "id": uid,
            "text": f["text"],
            "startMs": int(f["startMs"]),
            "endMs": int(f["endMs"]),
            "speakerId": spk_id,
            "speakerLabel": label,
            "speakerSource": source,
            **vp_meta,
        }
        with state_lock:
            utterances.append(utt_obj)
        emit({"type": "final", "utterance": utt_obj})
        copilot.on_final_utterance(utt_obj)
        corrector.enqueue(utt_obj)

    def _on_asr_error(msg: str, fatal: bool) -> None:
        emit({"type": "error", "message": msg, "fatal": fatal})

    def _on_engine_switch(engine_name: str, reason: str) -> None:
        emit({"type": "engine", "asrEngine": engine_name, "reason": reason})

    asr_mode = str(start_cmd.get("asrEngine") or "auto").strip()
    asr = AsrRouter(
        mode=asr_mode,
        asr_config=asr_config,
        hotwords=hotwords,
        ring=resolver.ring,
        on_status=_on_asr_status,
        on_partial=_on_partial,
        on_final=_on_final,
        on_error=_on_asr_error,
        on_engine_switch=_on_engine_switch,
    )

    stop_autosave = threading.Event()

    def _autosave_loop() -> None:
        while not stop_autosave.wait(timeout=30.0):
            try:
                _atomic_write_json(session_json_path, _build_session_doc())
            except Exception:
                pass

    autosave_thread = threading.Thread(target=_autosave_loop, name="LiveAutosave", daemon=True)
    autosave_thread.start()

    emit(
        {
            "type": "ready",
            "asrEngine": asr.initial_engine_name,
            "wavPath": wav_path,
            "outputDir": output_dir,
        }
    )
    copilot.start()
    corrector.start()
    asr.start()

    paused = False
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except Exception:
            continue
        ctype = cmd.get("type")
        if ctype == "audio":
            if paused:
                continue
            b64 = cmd.get("pcm") or ""
            if not b64:
                continue
            try:
                pcm_bytes = base64.b64decode(b64)
            except Exception:
                continue
            if not pcm_bytes:
                continue
            pcm_arr = np.frombuffer(pcm_bytes, dtype="<i2")
            resolver.append_audio(pcm_arr)
            with wav_lock:
                wav_file.writeframes(pcm_bytes)
            asr.push_audio(pcm_bytes)
        elif ctype == "pause":
            paused = True
            asr.pause()
        elif ctype == "resume":
            paused = False
            asr.resume()
        elif ctype == "add_speaker":
            spk = cmd.get("speaker") or {}
            sid = str(spk.get("id") or "").strip()
            sname = str(spk.get("name") or "").strip()
            srole = str(spk.get("role") or "counterpart").strip()
            if sid:
                added = resolver.add_speaker(sid, sname, srole)
                copilot.add_speaker(added)
        elif ctype == "rename_speaker":
            sid = str(cmd.get("speakerId") or "").strip()
            sname = str(cmd.get("name") or "").strip()
            if sid and sname:
                resolver.rename_speaker(sid, sname)
        elif ctype == "assign_speaker":
            uid = str(cmd.get("utteranceId") or "")
            sid = str(cmd.get("speakerId") or "")
            apply_lbl = bool(cmd.get("applyToLabel", True))
            upd = resolver.assign(uid, sid, apply_to_label=apply_lbl)
            if upd is not None:
                with state_lock:
                    for u in utterances:
                        if u["id"] == uid:
                            u["speakerId"] = upd["speakerId"]
                            u["speakerSource"] = "manual"
                            break
                copilot.update_utterance_speaker(uid, sid)
                emit({"type": "utterance_update", **upd})
        elif ctype == "request_insight":
            copilot.trigger_manual()
        elif ctype == "question_feedback":
            copilot.record_question_feedback(
                str(cmd.get("questionId") or ""),
                str(cmd.get("action") or ""),
            )
        elif ctype == "outline_override":
            copilot.set_outline_override(
                str(cmd.get("id") or ""),
                str(cmd.get("status") or "not_started"),
            )
        elif ctype == "stop":
            break

    # Ordered shutdown
    asr.stop()
    corrector.stop(timeout_sec=4.0)
    copilot.wait_current_and_stop(timeout_sec=25.0)
    final_summary = copilot.generate_final_summary(timeout_sec=30.0)
    if final_summary is not None:
        emit({"type": "final_summary", **final_summary})

    stop_autosave.set()
    try:
        _atomic_write_json(session_json_path, _build_session_doc())
    except Exception as exc:
        emit({"type": "error", "message": f"保存 session.json 失败: {exc}", "fatal": False})

    with wav_lock:
        try:
            wav_file.close()
        except Exception:
            pass

    emit(
        {
            "type": "stopped",
            "wavPath": wav_path,
            "sessionJsonPath": session_json_path,
            "durationMs": resolver.ring.total_ms,
        }
    )
