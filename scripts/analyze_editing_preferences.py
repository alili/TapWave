#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Deep Acoustic & Textual Editing Preferences Analyzer for PodCraft
Analyzes:
  1) /Users/nemo/Movies/10310 - 22 Oct 2026 坚叔/坚叔.podcraft
  2) 4-Track 48kHz / 24-bit WAVs in the same directory
"""

import json
import math
import os
import re
import statistics
import struct
import wave
from collections import Counter, defaultdict

PODCRAFT_PATH = "/Users/nemo/Movies/10310 - 22 Oct 2026 坚叔/坚叔.podcraft"
PROJECT_DIR = os.path.dirname(PODCRAFT_PATH)

def analyze():
    print(f"Loading {PODCRAFT_PATH}...")
    with open(PODCRAFT_PATH, "r", encoding="utf-8") as f:
        doc = json.load(f)
    proj = doc["project"]
    
    tracks = {t["id"]: t for t in proj["tracks"]}
    speakers = {t["id"]: t["name"] for t in proj["tracks"]}
    
    # Open WAV handles
    wav_handles = {}
    for tid, t in tracks.items():
        fp = t.get("filePath") or t.get("sourceFilePath")
        if fp and os.path.isfile(fp):
            try:
                wav_handles[tid] = wave.open(fp, "rb")
            except Exception as e:
                print(f"Warning: Could not open WAV for {tid}: {e}")
                
    def measure_wav_metrics(wf, start_ms, end_ms):
        if not wf:
            return -99.0, -99.0, 0.0
        sr = wf.getframerate()
        sw = wf.getsampwidth()
        n_ch = wf.getnchannels()
        f0 = max(0, int(start_ms / 1000.0 * sr))
        f1 = min(wf.getnframes(), int(end_ms / 1000.0 * sr))
        if f1 <= f0 or sw not in (2, 3, 4):
            return -99.0, -99.0, 0.0
        wf.setpos(f0)
        raw = wf.readframes(f1 - f0)
        step = sw * n_ch
        total_frames = len(raw) // step
        if total_frames == 0:
            return -99.0, -99.0, 0.0
        stride = max(1, total_frames // 4000)
        sq_sum = 0.0
        peak = 0.0
        cnt = 0
        zcr_crossings = 0
        prev_sign = 0
        for idx in range(0, total_frames, stride):
            offset = idx * step
            if sw == 2:
                val = struct.unpack_from("<h", raw, offset)[0] / 32768.0
            elif sw == 3:
                b = raw[offset:offset+3]
                ival = int.from_bytes(b, byteorder="little", signed=True)
                val = ival / 8388608.0
            else:
                val = struct.unpack_from("<i", raw, offset)[0] / 2147483648.0
            av = abs(val)
            if av > peak:
                peak = av
            sq_sum += val * val
            cnt += 1
            curr_sign = 1 if val > 0 else (-1 if val < 0 else 0)
            if prev_sign != 0 and curr_sign != 0 and prev_sign != curr_sign:
                zcr_crossings += 1
            prev_sign = curr_sign
        rms = math.sqrt(sq_sum / max(1, cnt))
        rms_db = 20 * math.log10(max(1e-6, rms))
        peak_db = 20 * math.log10(max(1e-6, peak))
        zcr = zcr_crossings / max(1, cnt)
        return rms_db, peak_db, zcr

    # Flatten tokens
    flat_tokens = []
    for b_idx, b in enumerate(proj["blocks"]):
        toks = b["tokens"]
        for t_idx, tok in enumerate(toks):
            flat_tokens.append({
                "b_idx": b_idx,
                "blockId": b["blockId"],
                "speakerId": b["speakerId"],
                "speakerName": speakers.get(b["speakerId"], b["speakerId"]),
                "t_idx": t_idx,
                "block_len": len(toks),
                "tok": tok,
            })

    # Cut Islands
    cut_islands = []
    cur = []
    for i, item in enumerate(flat_tokens):
        if item["tok"].get("deleted"):
            cur.append((i, item))
        else:
            if cur:
                cut_islands.append(cur)
                cur = []
    if cur:
        cut_islands.append(cur)

    # Room tones
    room_tones = {}
    for tid, t in tracks.items():
        s, e = t.get("roomToneStartMs", 0), t.get("roomToneEndMs", 1000)
        rms, _, _ = measure_wav_metrics(wav_handles.get(tid), s, e)
        room_tones[tid] = rms

    # Classify cut islands
    classified_islands = []
    island_categories = Counter()
    for isl in cut_islands:
        first_idx = isl[0][0]
        last_idx = isl[-1][0]
        toks = [x[1]["tok"] for x in isl]
        words = [t["text"] for t in toks if t["type"] == "word"]
        text_str = "".join(words)
        dur_s = max(0.0, (toks[-1]["sourceEndMs"] - toks[0]["sourceStartMs"]) / 1000.0)
        if dur_s == 0:
            dur_s = sum(t.get("origDurationSec", 0) for t in toks)
        start_s = toks[0]["sourceStartMs"] / 1000.0
        end_s = toks[-1]["sourceEndMs"] / 1000.0

        prev_text = "".join(flat_tokens[j]["tok"]["text"] for j in range(max(0, first_idx-6), first_idx) if flat_tokens[j]["tok"]["type"] == "word" and not flat_tokens[j]["tok"].get("deleted"))
        next_text = "".join(flat_tokens[j]["tok"]["text"] for j in range(last_idx+1, min(len(flat_tokens), last_idx+8)) if flat_tokens[j]["tok"]["type"] == "word" and not flat_tokens[j]["tok"].get("deleted"))

        all_sil = all(t["type"] == "silence" for t in toks)
        all_filler = len(words) > 0 and all(t.get("fillerTag") == "pure" or t["type"] == "silence" for t in toks)
        is_repeat = len(text_str) >= 1 and (next_text.startswith(text_str) or prev_text.endswith(text_str) or (len(text_str) >= 2 and text_str[:2] in next_text[:4]))

        if start_s < 15.0:
            cat = "head_off_air"
        elif start_s > 4560.0 and dur_s > 60.0:
            cat = "tail_off_air"
        elif all_sil:
            cat = "pure_silence"
        elif all_filler:
            cat = "hesitation_filler"
        elif is_repeat and len(words) <= 8:
            cat = "stutter_or_repeat"
        elif len(words) <= 3:
            cat = "short_false_start_or_phrase"
        elif len(words) <= 12:
            cat = "clause_cut"
        else:
            cat = "narrative_cut"

        island_categories[cat] += 1
        classified_islands.append({
            "cat": cat,
            "speaker": isl[0][1]["speakerName"],
            "speakerId": isl[0][1]["speakerId"],
            "start_s": start_s,
            "end_s": end_s,
            "dur_s": dur_s,
            "text": text_str,
            "prev_text": prev_text,
            "next_text": next_text,
            "tok_count": len(toks),
        })

    # Track mute ranges detailed audit
    mute_audits = []
    for m in proj.get("trackMuteRanges", []):
        tid = m["trackId"]
        s_ms, e_ms = m["sourceStartMs"], m["sourceEndMs"]
        dur = (e_ms - s_ms) / 1000.0
        sp_name = speakers.get(tid, tid)
        rms, peak, zcr = measure_wav_metrics(wav_handles.get(tid), s_ms, e_ms)
        rt = room_tones.get(tid, -80.0)
        snr = rms - rt

        # Concurrent voices on other tracks
        concurrent = []
        self_words = []
        for item in flat_tokens:
            tok = item["tok"]
            if tok["sourceEndMs"] > s_ms and tok["sourceStartMs"] < e_ms:
                if item["speakerId"] == tid:
                    self_words.append(tok["text"])
                elif tok["type"] == "word" and not tok.get("deleted"):
                    concurrent.append(f"{item['speakerName']}:{tok['text']}")

        # Characterize mute event
        if len(self_words) > 0 and "".join(self_words).strip():
            reason = f"未遂插话/自发言语消音 ({''.join(self_words)})"
        elif peak > -25.0:
            reason = "瞬态高能异响/杯具碰撞/清嗓 (CrestFactor高)"
        elif snr > 8.0:
            reason = "桌振/串音/低频杂音抑制"
        else:
            reason = "背景串音微杂音净化"

        mute_audits.append({
            "id": m["id"],
            "trackId": tid,
            "speaker": sp_name,
            "start_s": s_ms / 1000.0,
            "end_s": e_ms / 1000.0,
            "dur_s": dur,
            "rms_db": rms,
            "peak_db": peak,
            "snr_lift": snr,
            "zcr": zcr,
            "self_words": "".join(self_words),
            "concurrent": "".join(concurrent[:10]),
            "reason": reason
        })

    # Close handles
    for wf in wav_handles.values():
        wf.close()

    result = {
        "projectTitle": proj.get("projectTitle"),
        "speakers": speakers,
        "tokenStats": {
            "totalTokens": len(flat_tokens),
            "deletedTokens": sum(1 for x in flat_tokens if x["tok"].get("deleted")),
            "waveformCutTokens": sum(1 for x in flat_tokens if x["tok"].get("cutByWaveform")),
            "subwordTrimmedTokens": sum(1 for x in flat_tokens if x["tok"].get("subwordTrimmed")),
            "gapBeforeTokens": sum(1 for x in flat_tokens if x["tok"].get("gapBeforeSec") is not None),
        },
        "islandCategories": dict(island_categories),
        "cutIslands": classified_islands,
        "muteAudits": mute_audits,
    }
    
    out_json = os.path.join(PROJECT_DIR, "editing_preference_analysis.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"Analysis saved to {out_json}")
    return result

if __name__ == "__main__":
    analyze()
