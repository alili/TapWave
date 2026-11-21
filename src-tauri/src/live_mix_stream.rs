use serde::Deserialize;
use std::collections::HashMap;
use std::f32::consts::FRAC_PI_2;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::{Arc, OnceLock, RwLock};

pub const MIX_SAMPLE_RATE: u32 = 48_000;
const MIX_SAMPLE_RATE_F64: f64 = 48_000.0;
const WAV_HEADER_LEN: u64 = 44;
const RENDER_CHUNK_FRAMES: usize = 16_384;
const PREROLL_FRAMES: u64 = 7_200; // 150ms preroll for seamless envelope continuity across HTTP Range chunks
const SUB_WINDOW_FRAMES: usize = 480; // 10ms acoustic RMS sub-window
const LOOKAHEAD_FRAMES: usize = 240; // 5ms lookahead so consonant plosives open before arrival
const XFADE_FRAMES: u64 = 1_728; // 36ms phase-aligned adaptive equal-power crossfade
const HPF_85HZ_ALPHA: f32 = 0.988996; // 1st-order 85Hz high-pass @ 48kHz to remove rumble & DC offset

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMixTrackSpec {
    pub id: String,
    pub file_path: String,
    #[serde(default)]
    pub sync_offset_ms: i64,
    #[serde(default)]
    pub auto_gain_db: f32,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub solo: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMixSpanSpec {
    pub edited_start_sec: f64,
    pub edited_end_sec: f64,
    pub source_start_sec: f64,
    pub source_end_sec: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMixHighlightSpec {
    #[serde(default)]
    pub speaker_id: String,
    pub source_start_ms: i64,
    pub duration_sec: f64,
    #[serde(default)]
    pub muted_track_ids: Vec<String>,
    #[serde(default)]
    pub partially_muted_ranges: Vec<LiveMixIntervalSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMixAuxSpec {
    pub file_path: String,
    #[serde(default)]
    pub duration_sec: f64,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub custom_duration_sec: Option<f64>,
    #[serde(default)]
    pub start_offset_sec: Option<f64>,
    #[serde(default)]
    pub fade_in_ms: Option<i64>,
    #[serde(default)]
    pub fade_out_ms: Option<i64>,
    #[serde(default)]
    pub muted: Option<bool>,
    #[serde(default)]
    pub solo: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMixIntervalSpec {
    pub track_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMixRangeSpec {
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMixSpec {
    pub client_rev: Option<u64>,
    #[serde(default = "default_recording_mode")]
    pub recording_mode: String,
    #[serde(default = "default_true")]
    pub loudness_aligned: bool,
    #[serde(default = "default_auto_solo_mode")]
    pub auto_solo_mode: String,
    #[serde(default = "default_duck_db")]
    pub duck_attenuation_db: f32,
    #[serde(default = "default_true")]
    pub de_click_enabled: bool,
    #[serde(default = "default_declick_strength")]
    pub de_click_strength: String,
    #[serde(default = "default_bgm_duck_db")]
    pub bgm_duck_db: f32,
    #[serde(default = "default_highlight_gap_sec")]
    pub highlight_gap_sec: f64,
    #[serde(default)]
    pub cold_open_enabled: bool,
    #[serde(default)]
    pub cold_open_duration_sec: f64,
    #[serde(default)]
    pub intro_voiceover_duration_sec: f64,
    #[serde(default)]
    pub total_edited_duration_sec: f64,
    #[serde(default)]
    pub tracks: Vec<LiveMixTrackSpec>,
    #[serde(default)]
    pub playback_spans: Vec<LiveMixSpanSpec>,
    #[serde(default)]
    pub highlights: Vec<LiveMixHighlightSpec>,
    pub intro_voiceover: Option<LiveMixAuxSpec>,
    pub intro_bgm: Option<LiveMixAuxSpec>,
    pub outro_bgm: Option<LiveMixAuxSpec>,
    #[serde(default)]
    pub active_intervals: Vec<LiveMixIntervalSpec>,
    #[serde(default)]
    pub primary_intervals: Vec<LiveMixIntervalSpec>,
    #[serde(default)]
    pub laughter_ranges: Vec<LiveMixRangeSpec>,
    #[serde(default)]
    pub track_mutes: Vec<LiveMixIntervalSpec>,
    #[serde(default)]
    pub mouth_click_ranges: Vec<LiveMixIntervalSpec>,
    #[serde(default)]
    pub bleep_ranges: Vec<LiveMixRangeSpec>,
}

fn default_highlight_gap_sec() -> f64 {
    0.65
}
fn default_recording_mode() -> String {
    "same_room_sync".to_string()
}
fn default_true() -> bool {
    true
}
fn default_auto_solo_mode() -> String {
    "natural_ducking".to_string()
}
fn default_duck_db() -> f32 {
    -20.0
}
fn default_declick_strength() -> String {
    "medium".to_string()
}
fn default_bgm_duck_db() -> f32 {
    -18.0
}

#[derive(Debug, Clone)]
pub struct PcmWavHeader {
    pub data_offset: u64,
    pub data_size: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub is_float: bool,
    pub block_align: u16,
    pub total_frames: u64,
}

impl PcmWavHeader {
    pub fn probe(path: &str) -> Result<Self, String> {
        let mut f = File::open(path).map_err(|e| format!("无法打开 WAV ({}): {}", path, e))?;
        let file_len = f.metadata().map_err(|e| e.to_string())?.len();
        if file_len < 44 {
            return Err("WAV 文件过短".into());
        }

        let mut riff_hdr = [0u8; 12];
        f.read_exact(&mut riff_hdr).map_err(|e| e.to_string())?;
        if &riff_hdr[0..4] != b"RIFF" || &riff_hdr[8..12] != b"WAVE" {
            return Err("非标准 RIFF/WAVE 文件头".into());
        }

        let mut pos: u64 = 12;
        let mut fmt_found = false;
        let mut format_tag: u16;
        let mut channels: u16 = 1;
        let mut sample_rate: u32 = MIX_SAMPLE_RATE;
        let mut block_align: u16 = 2;
        let mut bits_per_sample: u16 = 16;
        let mut is_float = false;

        let mut data_offset: u64 = 0;
        let mut data_size: u64 = 0;
        let mut data_found = false;

        while pos + 8 <= file_len {
            f.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
            let mut ch_hdr = [0u8; 8];
            if f.read_exact(&mut ch_hdr).is_err() {
                break;
            }
            let chunk_id = [ch_hdr[0], ch_hdr[1], ch_hdr[2], ch_hdr[3]];
            let chunk_size = u32::from_le_bytes([ch_hdr[4], ch_hdr[5], ch_hdr[6], ch_hdr[7]]) as u64;
            let payload_pos = pos + 8;

            if &chunk_id == b"fmt " && chunk_size >= 16 {
                let to_read = (chunk_size.min(64)) as usize;
                let mut fmt_buf = vec![0u8; to_read];
                f.read_exact(&mut fmt_buf).map_err(|e| e.to_string())?;
                format_tag = u16::from_le_bytes([fmt_buf[0], fmt_buf[1]]);
                channels = u16::from_le_bytes([fmt_buf[2], fmt_buf[3]]).max(1);
                sample_rate = u32::from_le_bytes([fmt_buf[4], fmt_buf[5], fmt_buf[6], fmt_buf[7]]).max(8000);
                block_align = u16::from_le_bytes([fmt_buf[12], fmt_buf[13]]);
                bits_per_sample = u16::from_le_bytes([fmt_buf[14], fmt_buf[15]]);

                if format_tag == 0xFFFE && fmt_buf.len() >= 26 {
                    // WAVE_FORMAT_EXTENSIBLE: subformat GUID bytes 24..26
                    let sub_tag = u16::from_le_bytes([fmt_buf[24], fmt_buf[25]]);
                    format_tag = sub_tag;
                }
                if format_tag == 3 {
                    is_float = true;
                } else if format_tag != 1 {
                    return Err(format!("不支持的 WAV 编码格式 tag={}", format_tag));
                }
                if block_align == 0 {
                    block_align = channels * (bits_per_sample / 8).max(1);
                }
                fmt_found = true;
            } else if &chunk_id == b"data" {
                data_offset = payload_pos;
                data_size = chunk_size.min(file_len.saturating_sub(payload_pos));
                data_found = true;
                if fmt_found {
                    break;
                }
            }

            // RIFF chunks are word-aligned (even byte boundary)
            let padded = chunk_size + (chunk_size % 2);
            let next_pos = payload_pos.saturating_add(padded);
            if next_pos <= pos {
                break;
            }
            pos = next_pos;
        }

        if !fmt_found || !data_found || block_align == 0 {
            return Err("未找到有效 WAV fmt/data 块".into());
        }
        let supported_bps = if is_float {
            bits_per_sample == 32
        } else {
            bits_per_sample == 16 || bits_per_sample == 24 || bits_per_sample == 32
        };
        if !supported_bps {
            return Err(format!("不支持的 WAV 位深: {}bit", bits_per_sample));
        }

        let total_frames = data_size / (block_align as u64);
        Ok(Self {
            data_offset,
            data_size,
            sample_rate,
            channels,
            bits_per_sample,
            is_float,
            block_align,
            total_frames,
        })
    }
}

struct WavStreamReader {
    file: File,
    hdr: PcmWavHeader,
    scratch: Vec<u8>,
    tmp_src_f32: Vec<f32>,
}

impl WavStreamReader {
    fn open(path: &str, hdr: PcmWavHeader) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| e.to_string())?;
        Ok(Self {
            file,
            hdr,
            scratch: Vec::with_capacity(65_536),
            tmp_src_f32: Vec::with_capacity(20_480),
        })
    }

    #[inline]
    fn decode_mono_frame(&self, bytes: &[u8]) -> f32 {
        let ch = self.hdr.channels as usize;
        let bytes_per_sample = (self.hdr.bits_per_sample / 8) as usize;
        if bytes.len() < ch * bytes_per_sample {
            return 0.0;
        }
        let mut sum = 0.0_f32;
        for c in 0..ch {
            let off = c * bytes_per_sample;
            let val = if self.hdr.is_float && bytes_per_sample == 4 {
                f32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
            } else if bytes_per_sample == 2 {
                let s = i16::from_le_bytes([bytes[off], bytes[off + 1]]);
                (s as f32) / 32768.0
            } else if bytes_per_sample == 3 {
                let raw = ((bytes[off + 2] as i32) << 24)
                    | ((bytes[off + 1] as i32) << 16)
                    | ((bytes[off] as i32) << 8);
                ((raw >> 8) as f32) / 8_388_608.0
            } else if bytes_per_sample == 4 {
                let s = i32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]]);
                (s as f32) / 2_147_483_648.0
            } else {
                0.0
            };
            sum += val;
        }
        if ch > 1 {
            sum / (ch as f32)
        } else {
            sum
        }
    }

    /// Reads `count` mono 48kHz samples starting at virtual 48kHz `start_frame_48k` into `out`.
    fn read_mono_48k(&mut self, start_frame_48k: u64, out: &mut [f32]) {
        out.fill(0.0);
        if out.is_empty() || self.hdr.total_frames == 0 {
            return;
        }

        if self.hdr.sample_rate == MIX_SAMPLE_RATE {
            if start_frame_48k >= self.hdr.total_frames {
                return;
            }
            let avail = (self.hdr.total_frames - start_frame_48k).min(out.len() as u64) as usize;
            let ba = self.hdr.block_align as usize;
            let need_bytes = avail * ba;
            self.scratch.resize(need_bytes, 0);
            let byte_pos = self.hdr.data_offset + start_frame_48k * (self.hdr.block_align as u64);
            if self.file.seek(SeekFrom::Start(byte_pos)).is_err() {
                return;
            }
            let mut got = 0usize;
            while got < need_bytes {
                match self.file.read(&mut self.scratch[got..need_bytes]) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => got += n,
                }
            }
            let decoded_frames = got / ba;
            if self.hdr.channels == 1 && !self.hdr.is_float && self.hdr.bits_per_sample == 16 {
                // Ultra-fast 16-bit mono inner loop for Zoom P4next stems
                for i in 0..decoded_frames {
                    let off = i * 2;
                    let s = i16::from_le_bytes([self.scratch[off], self.scratch[off + 1]]);
                    out[i] = (s as f32) * (1.0 / 32768.0);
                }
            } else {
                for i in 0..decoded_frames {
                    let off = i * ba;
                    out[i] = self.decode_mono_frame(&self.scratch[off..off + ba]);
                }
            }
            return;
        }

        // Resampling path for non-48kHz BGM / Intro VO assets
        let ratio = (self.hdr.sample_rate as f64) / MIX_SAMPLE_RATE_F64;
        let src_start_f = (start_frame_48k as f64) * ratio;
        let src_end_f = ((start_frame_48k + out.len() as u64) as f64) * ratio;
        let src_first = src_start_f.floor().max(0.0) as u64;
        if src_first >= self.hdr.total_frames {
            return;
        }
        let src_last = ((src_end_f.ceil() as u64) + 2).min(self.hdr.total_frames);
        let src_count = src_last.saturating_sub(src_first) as usize;
        if src_count == 0 {
            return;
        }

        let ba = self.hdr.block_align as usize;
        let need_bytes = src_count * ba;
        self.scratch.resize(need_bytes, 0);
        let byte_pos = self.hdr.data_offset + src_first * (self.hdr.block_align as u64);
        if self.file.seek(SeekFrom::Start(byte_pos)).is_err() {
            return;
        }
        let mut got = 0usize;
        while got < need_bytes {
            match self.file.read(&mut self.scratch[got..need_bytes]) {
                Ok(0) | Err(_) => break,
                Ok(n) => got += n,
            }
        }
        let decoded = got / ba;
        self.tmp_src_f32.resize(decoded, 0.0);
        for i in 0..decoded {
            let off = i * ba;
            self.tmp_src_f32[i] = self.decode_mono_frame(&self.scratch[off..off + ba]);
        }
        if self.tmp_src_f32.is_empty() {
            return;
        }

        for (k, dst) in out.iter_mut().enumerate() {
            let pos_f = ((start_frame_48k + k as u64) as f64) * ratio - (src_first as f64);
            if pos_f < 0.0 {
                continue;
            }
            let idx = pos_f.floor() as usize;
            if idx >= self.tmp_src_f32.len() {
                break;
            }
            let frac = (pos_f - (idx as f64)) as f32;
            let a = self.tmp_src_f32[idx];
            let b = if idx + 1 < self.tmp_src_f32.len() {
                self.tmp_src_f32[idx + 1]
            } else {
                a
            };
            *dst = a + (b - a) * frac;
        }
    }
}

#[derive(Debug, Clone)]
struct PreparedTrack {
    #[allow(dead_code)]
    id: String,
    resolved_wav_path: String,
    wav_header: PcmWavHeader,
    offset_frames: i64,
    base_gain: f32,
    muted_or_unsoloed: bool,
    active_intervals: Vec<(i64, i64)>,
    primary_intervals: Vec<(i64, i64)>,
    track_mutes: Vec<(i64, i64)>,
    mouth_click_ranges: Vec<(i64, i64)>,
}

#[derive(Debug, Clone)]
struct PreparedAuxAsset {
    resolved_wav_path: String,
    wav_header: PcmWavHeader,
    frames_48k: u64,
}

#[derive(Debug, Clone)]
enum TimelineRegionKind {
    IdleGap,
    HighlightSlice {
        source_start_frame: u64,
        slice_frames: u64,
    },
    IntroVoSlice,
    BodySpan {
        source_start_frame: u64,
        prev_source_end_frame: Option<u64>,
        xfade_frames: u64,
        splice_corr: f32,
    },
}

#[derive(Debug, Clone)]
struct TimelineRegion {
    edit_start_frame: u64,
    edit_end_frame: u64,
    kind: TimelineRegionKind,
}

#[derive(Debug, Clone)]
pub struct PreparedLiveMix {
    pub rev: u64,
    pub total_frames: u64,
    pub wav_header_bytes: [u8; 44],
    pub total_wav_len: u64,
    auto_solo_mode: String,
    duck_linear: f32,
    de_click_enabled: bool,
    de_click_strong: bool,
    bgm_duck_linear: f32,
    intro_end_frame: u64,
    outro_start_frame: u64,
    cold_quotes_range: Option<(u64, u64)>,
    tracks: Vec<PreparedTrack>,
    intro_vo: Option<PreparedAuxAsset>,
    intro_bgm: Option<PreparedAuxAsset>,
    outro_bgm: Option<PreparedAuxAsset>,
    regions: Vec<TimelineRegion>,
    laughter_ranges: Vec<(i64, i64)>,
    bleep_ranges: Vec<(i64, i64)>,
}

struct LiveMixStore {
    next_rev: u64,
    revisions: Vec<Arc<PreparedLiveMix>>,
}

static LIVE_MIX_STORE: OnceLock<RwLock<LiveMixStore>> = OnceLock::new();

fn mix_store() -> &'static RwLock<LiveMixStore> {
    LIVE_MIX_STORE.get_or_init(|| {
        RwLock::new(LiveMixStore {
            next_rev: 1,
            revisions: Vec::new(),
        })
    })
}

fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

/// Aligns a BodySpan cut boundary within `±5.5ms` (±264 samples @ 48kHz) to match incoming
/// waveform phase, zero-crossing slope, and continuity against the outgoing tail, preventing
/// phase cancellation dips and clicks while staying 100% deterministic across HTTP 206 chunks.
fn align_body_span_splice_frame(
    tracks: &[PreparedTrack],
    prev_end_frame: u64,
    raw_start_frame: u64,
    span_len_frames: u64,
) -> (u64, f32) {
    if span_len_frames < 960 || tracks.is_empty() {
        return (raw_start_frame, 0.0);
    }

    let corr_win = 240usize; // 5ms correlation comparison window
    let search_rad: usize = 264; // ±5.5ms (covers >= half pitch cycle down to ~91Hz voice)
    let mut out_ref = vec![0.0_f32; corr_win];
    let mut out_prev2 = [0.0_f32; 2];

    let min_cand = raw_start_frame.saturating_sub(search_rad as u64);
    let cand_span = (raw_start_frame + search_rad as u64 + corr_win as u64)
        .saturating_sub(min_cand) as usize;
    let mut cand_buf = vec![0.0_f32; cand_span];
    let mut tmp = vec![0.0_f32; cand_span.max(corr_win)];

    for tr in tracks {
        if tr.muted_or_unsoloed {
            continue;
        }
        let Ok(mut reader) = WavStreamReader::open(&tr.resolved_wav_path, tr.wav_header.clone())
        else {
            continue;
        };
        if prev_end_frame >= 2 {
            let p_adj = ((prev_end_frame - 2) as i64 - tr.offset_frames).max(0) as u64;
            reader.read_mono_48k(p_adj, &mut tmp[..2]);
            out_prev2[0] += tmp[0] * tr.base_gain;
            out_prev2[1] += tmp[1] * tr.base_gain;
        }
        let o_adj = (prev_end_frame as i64 - tr.offset_frames).max(0) as u64;
        reader.read_mono_48k(o_adj, &mut tmp[..corr_win]);
        for i in 0..corr_win {
            out_ref[i] += tmp[i] * tr.base_gain;
        }
        let c_adj = (min_cand as i64 - tr.offset_frames).max(0) as u64;
        reader.read_mono_48k(c_adj, &mut tmp[..cand_span]);
        for i in 0..cand_span {
            cand_buf[i] += tmp[i] * tr.base_gain;
        }
    }

    let out_energy: f32 = out_ref.iter().map(|v| v * v).sum();
    let max_cand_off = cand_span.saturating_sub(corr_win + 1);
    if max_cand_off == 0 {
        return (raw_start_frame, 0.0);
    }

    // If outgoing tail is very quiet, pick the lowest-amplitude zero-crossing near raw_start_frame
    let raw_idx = (raw_start_frame - min_cand) as usize;
    if out_energy < 1e-4 {
        let mut best_idx = raw_idx.min(max_cand_off);
        let mut best_score = f32::MAX;
        for idx in 0..=max_cand_off {
            let v0 = cand_buf[idx];
            let v1 = cand_buf[idx + 1];
            let zc = (v0 >= 0.0 && v1 <= 0.0) || (v0 <= 0.0 && v1 >= 0.0);
            let dist = ((idx as isize - raw_idx as isize).unsigned_abs() as f32)
                / (search_rad.max(1) as f32);
            let score = v0.abs() + (if zc { 0.0 } else { 0.02 }) + 0.005 * dist;
            if score < best_score {
                best_score = score;
                best_idx = idx;
            }
        }
        return (min_cand + best_idx as u64, 0.0);
    }

    let y_prev = out_prev2[1];
    let dy_prev = out_prev2[1] - out_prev2[0];
    let out_norm = out_energy.sqrt();

    let mut best_idx = raw_idx.min(max_cand_off);
    let mut best_score = f32::NEG_INFINITY;
    let mut best_corr = 0.0_f32;

    for idx in 0..=max_cand_off {
        let mut dot = 0.0_f32;
        let mut in_energy = 0.0_f32;
        for k in 0..corr_win {
            let in_s = cand_buf[idx + k];
            dot += out_ref[k] * in_s;
            in_energy += in_s * in_s;
        }
        let denom = out_norm * in_energy.sqrt();
        let corr = if denom > 1e-6 { dot / denom } else { 0.0 };
        let dy_in = cand_buf[idx + 1] - cand_buf[idx];
        let step_err = (cand_buf[idx] - y_prev).abs() + 0.5 * (dy_in - dy_prev).abs();
        let dist = ((idx as isize - raw_idx as isize).unsigned_abs() as f32)
            / (search_rad.max(1) as f32);
        let score = corr - 1.4 * step_err - 0.03 * dist;
        if score > best_score {
            best_score = score;
            best_idx = idx;
            best_corr = corr;
        }
    }

    (min_cand + best_idx as u64, best_corr.clamp(0.0, 1.0))
}

fn merge_sorted_ranges(mut ranges: Vec<(i64, i64)>) -> Vec<(i64, i64)> {
    if ranges.is_empty() {
        return ranges;
    }
    ranges.sort_unstable_by_key(|r| (r.0, r.1));
    let mut out: Vec<(i64, i64)> = Vec::with_capacity(ranges.len());
    for (s, e) in ranges {
        let e = e.max(s);
        if let Some(last) = out.last_mut() {
            if s <= last.1 + 10 {
                last.1 = last.1.max(e);
                continue;
            }
        }
        out.push((s, e));
    }
    out
}

#[inline]
fn range_contains_with_margin(ranges: &[(i64, i64)], t_ms: i64, pad_before_ms: i64, pad_after_ms: i64) -> bool {
    if ranges.is_empty() {
        return false;
    }
    // Binary search last range whose start <= t_ms + pad_before_ms
    let target_start = t_ms.saturating_add(pad_before_ms);
    let idx = ranges.partition_point(|r| r.0 <= target_start);
    if idx > 0 {
        let r = ranges[idx - 1];
        if t_ms <= r.1.saturating_add(pad_after_ms) && t_ms >= r.0.saturating_sub(pad_before_ms) {
            return true;
        }
    }
    false
}

#[inline]
fn track_mute_gain_at(ranges: &[(i64, i64)], t_ms: i64) -> f32 {
    if ranges.is_empty() {
        return 1.0;
    }
    let idx = ranges.partition_point(|r| r.0 <= t_ms + 12);
    if idx > 0 {
        let (s, e) = ranges[idx - 1];
        if t_ms >= s && t_ms <= e {
            let fade = 10_i64.min(((e - s) / 3).max(1));
            if t_ms < s + fade {
                let p = (t_ms - s) as f32 / (fade as f32);
                return 0.5 * (1.0 + (p * std::f32::consts::PI).cos());
            }
            if t_ms > e - fade {
                let p = (e - t_ms) as f32 / (fade as f32);
                return 0.5 * (1.0 + (p * std::f32::consts::PI).cos());
            }
            return 0.0;
        }
    }
    1.0
}

fn resolve_pcm_wav_asset(raw_path: &str) -> Result<(String, PcmWavHeader), String> {
    if raw_path.is_empty() || !Path::new(raw_path).exists() {
        return Err(format!("音频文件不存在: {}", raw_path));
    }
    if !crate::needs_wav_transcode(raw_path) {
        if let Ok(hdr) = PcmWavHeader::probe(raw_path) {
            return Ok((raw_path.to_string(), hdr));
        }
    }
    let cached_wav = crate::transcode_to_cached_wav(raw_path)?;
    let hdr = PcmWavHeader::probe(&cached_wav)?;
    Ok((cached_wav, hdr))
}

fn build_wav_header_44(total_pcm_bytes: u64) -> [u8; 44] {
    let data_bytes_u32 = total_pcm_bytes.min(u32::MAX as u64 - 36) as u32;
    let riff_size = data_bytes_u32.saturating_add(36);
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&riff_size.to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
    h[24..28].copy_from_slice(&MIX_SAMPLE_RATE.to_le_bytes());
    h[28..32].copy_from_slice(&(MIX_SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    h[32..34].copy_from_slice(&2u16.to_le_bytes()); // block align
    h[34..36].copy_from_slice(&16u16.to_le_bytes()); // bits per sample
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_bytes_u32.to_le_bytes());
    h
}

pub fn build_prepared_live_mix(spec: LiveMixSpec, rev: u64) -> Result<PreparedLiveMix, String> {
    let any_solo = spec.tracks.iter().any(|t| t.solo);
    let mut active_by_id: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
    for iv in &spec.active_intervals {
        active_by_id
            .entry(iv.track_id.clone())
            .or_default()
            .push((iv.start_ms, iv.end_ms));
    }
    let mut primary_by_id: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
    for iv in &spec.primary_intervals {
        primary_by_id
            .entry(iv.track_id.clone())
            .or_default()
            .push((iv.start_ms, iv.end_ms));
    }
    let mut mutes_by_id: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
    for iv in &spec.track_mutes {
        mutes_by_id
            .entry(iv.track_id.clone())
            .or_default()
            .push((iv.start_ms, iv.end_ms));
    }
    let mut clicks_by_id: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
    for iv in &spec.mouth_click_ranges {
        clicks_by_id
            .entry(iv.track_id.clone())
            .or_default()
            .push((iv.start_ms, iv.end_ms));
    }

    let mut prepared_tracks = Vec::with_capacity(spec.tracks.len());
    for tr in &spec.tracks {
        let (wav_path, hdr) = resolve_pcm_wav_asset(&tr.file_path)?;
        let offset_ms = if spec.recording_mode == "same_room_sync" {
            0
        } else {
            tr.sync_offset_ms
        };
        let offset_frames = ((offset_ms as f64) * MIX_SAMPLE_RATE_F64 / 1000.0).round() as i64;
        let muted_or_unsoloed = tr.muted || (any_solo && !tr.solo);
        let base_gain = if muted_or_unsoloed {
            0.0
        } else if spec.loudness_aligned {
            (0.90 * db_to_linear(tr.auto_gain_db.clamp(-12.0, 8.0))).min(1.65)
        } else {
            0.90
        };

        prepared_tracks.push(PreparedTrack {
            id: tr.id.clone(),
            resolved_wav_path: wav_path,
            wav_header: hdr,
            offset_frames,
            base_gain,
            muted_or_unsoloed,
            active_intervals: merge_sorted_ranges(
                active_by_id.remove(&tr.id).unwrap_or_default(),
            ),
            primary_intervals: merge_sorted_ranges(
                primary_by_id.remove(&tr.id).unwrap_or_default(),
            ),
            track_mutes: merge_sorted_ranges(mutes_by_id.remove(&tr.id).unwrap_or_default()),
            mouth_click_ranges: merge_sorted_ranges(
                clicks_by_id.remove(&tr.id).unwrap_or_default(),
            ),
        });
    }

    let resolve_aux = |opt: &Option<LiveMixAuxSpec>| -> Option<PreparedAuxAsset> {
        let aux = opt.as_ref()?;
        if !aux.enabled || aux.file_path.is_empty() {
            return None;
        }
        let (wav_path, hdr) = resolve_pcm_wav_asset(&aux.file_path).ok()?;
        let dur_frames = if aux.duration_sec > 0.05 {
            (aux.duration_sec * MIX_SAMPLE_RATE_F64).round() as u64
        } else {
            ((hdr.total_frames as f64) * MIX_SAMPLE_RATE_F64 / (hdr.sample_rate as f64)).round()
                as u64
        };
        Some(PreparedAuxAsset {
            resolved_wav_path: wav_path,
            wav_header: hdr,
            frames_48k: dur_frames.max(1),
        })
    };

    let intro_vo = if spec.intro_voiceover_duration_sec > 0.0 {
        resolve_aux(&spec.intro_voiceover)
    } else {
        None
    };
    let intro_bgm = resolve_aux(&spec.intro_bgm);
    let outro_bgm = resolve_aux(&spec.outro_bgm);

    // Build ordered, non-overlapping regions anchored to frontend timeline edited timestamps
    let mut regions: Vec<TimelineRegion> = Vec::new();
    let cold_end_frame = (spec.cold_open_duration_sec.max(0.0) * MIX_SAMPLE_RATE_F64).round() as u64;
    let intro_vo_start_sec = spec.intro_voiceover.as_ref().and_then(|v| v.start_offset_sec).unwrap_or(spec.cold_open_duration_sec.max(0.0));
    let intro_vo_start_frame = (intro_vo_start_sec.max(0.0) * MIX_SAMPLE_RATE_F64).round() as u64;
    let intro_vo_frames = (spec.intro_voiceover_duration_sec.max(0.0) * MIX_SAMPLE_RATE_F64).round() as u64;
    let prefix_end_frame = cold_end_frame.max(intro_vo_start_frame + intro_vo_frames);
    let mut cold_quotes_range: Option<(u64, u64)> = None;

    if spec.cold_open_enabled && !spec.highlights.is_empty() && cold_end_frame > 0 {
        let gap_sec = spec.highlight_gap_sec.max(0.2).min(3.0);
        let mut cursor_sec = 2.0_f64;
        let quotes_start_f = (2.0 * MIX_SAMPLE_RATE_F64).round() as u64;
        regions.push(TimelineRegion {
            edit_start_frame: 0,
            edit_end_frame: quotes_start_f,
            kind: TimelineRegionKind::IdleGap,
        });
        for (idx, hl) in spec.highlights.iter().enumerate() {
            let start_f = (cursor_sec * MIX_SAMPLE_RATE_F64).round() as u64;
            let end_f = ((cursor_sec + hl.duration_sec.max(0.0)) * MIX_SAMPLE_RATE_F64).round() as u64;
            let src_start_f = ((hl.source_start_ms.max(0) as f64) * MIX_SAMPLE_RATE_F64 / 1000.0).round() as u64;
            if end_f > start_f {
                regions.push(TimelineRegion {
                    edit_start_frame: start_f.min(cold_end_frame),
                    edit_end_frame: end_f.min(cold_end_frame),
                    kind: TimelineRegionKind::HighlightSlice {
                        source_start_frame: src_start_f,
                        slice_frames: end_f - start_f,
                    },
                });
            }
            cursor_sec += hl.duration_sec.max(0.0);
            if idx + 1 < spec.highlights.len() {
                let gap_start = (cursor_sec * MIX_SAMPLE_RATE_F64).round() as u64;
                cursor_sec += gap_sec;
                let gap_end = ((cursor_sec * MIX_SAMPLE_RATE_F64).round() as u64).min(cold_end_frame);
                if gap_end > gap_start {
                    regions.push(TimelineRegion {
                        edit_start_frame: gap_start,
                        edit_end_frame: gap_end,
                        kind: TimelineRegionKind::IdleGap,
                    });
                }
            }
        }
        let tail_start = ((cursor_sec * MIX_SAMPLE_RATE_F64).round() as u64).min(cold_end_frame);
        cold_quotes_range = Some((quotes_start_f, tail_start));
        if cold_end_frame > tail_start {
            regions.push(TimelineRegion {
                edit_start_frame: tail_start,
                edit_end_frame: cold_end_frame,
                kind: TimelineRegionKind::IdleGap,
            });
        }
    }

    if intro_vo_frames > 0 {
        regions.push(TimelineRegion {
            edit_start_frame: intro_vo_start_frame,
            edit_end_frame: intro_vo_start_frame + intro_vo_frames,
            kind: TimelineRegionKind::IntroVoSlice,
        });
    }

    let mut last_span_end_frame = prefix_end_frame;
    for (idx, sp) in spec.playback_spans.iter().enumerate() {
        let es = (sp.edited_start_sec.max(0.0) * MIX_SAMPLE_RATE_F64).round() as u64;
        let ee = (sp.edited_end_sec.max(sp.edited_start_sec) * MIX_SAMPLE_RATE_F64).round() as u64;
        if ee <= es {
            continue;
        }
        if es > last_span_end_frame {
            regions.push(TimelineRegion {
                edit_start_frame: last_span_end_frame,
                edit_end_frame: es,
                kind: TimelineRegionKind::IdleGap,
            });
        }
        let raw_src_s = (sp.source_start_sec.max(0.0) * MIX_SAMPLE_RATE_F64).round() as u64;
        let prev_src_end = if idx > 0 {
            Some((spec.playback_spans[idx - 1].source_end_sec.max(0.0) * MIX_SAMPLE_RATE_F64).round() as u64)
        } else {
            None
        };
        let xfade_frames = if idx > 0 {
            XFADE_FRAMES.min((ee - es) / 3)
        } else {
            0
        };
        let (src_s, splice_corr) = if let Some(prev_end) = prev_src_end {
            align_body_span_splice_frame(&prepared_tracks, prev_end, raw_src_s, ee - es)
        } else {
            (raw_src_s, 0.0)
        };
        regions.push(TimelineRegion {
            edit_start_frame: es,
            edit_end_frame: ee,
            kind: TimelineRegionKind::BodySpan {
                source_start_frame: src_s,
                prev_source_end_frame: prev_src_end,
                xfade_frames,
                splice_corr,
            },
        });
        last_span_end_frame = last_span_end_frame.max(ee);
    }

    let total_sec_frames = (spec.total_edited_duration_sec.max(0.0) * MIX_SAMPLE_RATE_F64).round() as u64;
    let total_frames = total_sec_frames.max(last_span_end_frame).max(1);
    if total_frames > last_span_end_frame {
        regions.push(TimelineRegion {
            edit_start_frame: last_span_end_frame,
            edit_end_frame: total_frames,
            kind: TimelineRegionKind::IdleGap,
        });
    }

    let total_dur_sec = (total_frames as f64) / MIX_SAMPLE_RATE_F64;
    let prefix_sec = (prefix_end_frame as f64) / MIX_SAMPLE_RATE_F64;
    let custom_intro_bgm_sec = spec.intro_bgm.as_ref().and_then(|b| b.custom_duration_sec).unwrap_or(0.0);
    let intro_end_sec = if custom_intro_bgm_sec > 0.0 {
        custom_intro_bgm_sec
    } else if prefix_sec > 0.0 {
        prefix_sec
    } else {
        (total_dur_sec * 0.35).min(10.0)
    };
    let outro_window_sec = (total_dur_sec * 0.25).max(4.0).min(12.0);
    let outro_start_sec = if total_dur_sec > 4.0 {
        (total_dur_sec - outro_window_sec).max(intro_end_sec + 0.5)
    } else {
        total_dur_sec + 1.0
    };

    let total_pcm_bytes = total_frames.saturating_mul(2);
    let wav_header_bytes = build_wav_header_44(total_pcm_bytes);
    let duck_linear = if spec.auto_solo_mode == "natural_ducking" {
        db_to_linear(spec.duck_attenuation_db).clamp(0.10, 0.55)
    } else {
        0.06
    };

    Ok(PreparedLiveMix {
        rev,
        total_frames,
        wav_header_bytes,
        total_wav_len: WAV_HEADER_LEN + total_pcm_bytes,
        auto_solo_mode: spec.auto_solo_mode,
        duck_linear,
        de_click_enabled: spec.de_click_enabled,
        de_click_strong: spec.de_click_strength == "strong",
        bgm_duck_linear: db_to_linear(spec.bgm_duck_db).clamp(0.04, 0.85),
        intro_end_frame: (intro_end_sec * MIX_SAMPLE_RATE_F64).round() as u64,
        outro_start_frame: (outro_start_sec * MIX_SAMPLE_RATE_F64).round() as u64,
        cold_quotes_range,
        tracks: prepared_tracks,
        intro_vo,
        intro_bgm,
        outro_bgm,
        regions,
        laughter_ranges: merge_sorted_ranges(
            spec.laughter_ranges
                .into_iter()
                .map(|r| (r.start_ms, r.end_ms))
                .collect(),
        ),
        bleep_ranges: merge_sorted_ranges(
            spec.bleep_ranges
                .into_iter()
                .map(|r| (r.start_ms, r.end_ms))
                .collect(),
        ),
    })
}

pub fn register_live_mix(spec: LiveMixSpec) -> Result<Arc<PreparedLiveMix>, String> {
    let rev = {
        let mut guard = mix_store().write().map_err(|e| e.to_string())?;
        let r = guard.next_rev;
        guard.next_rev = guard.next_rev.saturating_add(1);
        r
    };
    let prepared = Arc::new(build_prepared_live_mix(spec, rev)?);
    let mut guard = mix_store().write().map_err(|e| e.to_string())?;
    guard.revisions.push(Arc::clone(&prepared));
    if guard.revisions.len() > 4 {
        let drain = guard.revisions.len() - 4;
        guard.revisions.drain(0..drain);
    }
    Ok(prepared)
}

pub fn get_live_mix(requested_rev: Option<u64>) -> Option<Arc<PreparedLiveMix>> {
    let guard = mix_store().read().ok()?;
    if let Some(r) = requested_rev {
        if let Some(found) = guard.revisions.iter().rev().find(|m| m.rev == r) {
            return Some(Arc::clone(found));
        }
    }
    guard.revisions.last().map(Arc::clone)
}

struct LiveMixRenderSession<'a> {
    mix: &'a PreparedLiveMix,
    track_readers: Vec<Option<WavStreamReader>>,
    intro_vo_reader: Option<WavStreamReader>,
    intro_bgm_reader: Option<WavStreamReader>,
    outro_bgm_reader: Option<WavStreamReader>,
    track_bufs: Vec<Vec<f32>>,
    xfade_bufs: Vec<Vec<f32>>,
    aux_buf: Vec<f32>,
    bgm_buf: Vec<f32>,
    hp_x1: Vec<f32>,
    hp_y1: Vec<f32>,
    noise_floor: Vec<f32>,
    hold_frames_rem: Vec<usize>,
}

impl<'a> LiveMixRenderSession<'a> {
    fn open(mix: &'a PreparedLiveMix) -> Self {
        let mut track_readers = Vec::with_capacity(mix.tracks.len());
        let mut track_bufs = Vec::with_capacity(mix.tracks.len());
        let mut xfade_bufs = Vec::with_capacity(mix.tracks.len());
        for tr in &mix.tracks {
            let reader = if tr.muted_or_unsoloed {
                None
            } else {
                WavStreamReader::open(&tr.resolved_wav_path, tr.wav_header.clone()).ok()
            };
            track_readers.push(reader);
            track_bufs.push(vec![0.0_f32; RENDER_CHUNK_FRAMES]);
            xfade_bufs.push(vec![0.0_f32; XFADE_FRAMES as usize]);
        }
        let intro_vo_reader = mix
            .intro_vo
            .as_ref()
            .and_then(|a| WavStreamReader::open(&a.resolved_wav_path, a.wav_header.clone()).ok());
        let intro_bgm_reader = mix
            .intro_bgm
            .as_ref()
            .and_then(|a| WavStreamReader::open(&a.resolved_wav_path, a.wav_header.clone()).ok());
        let outro_bgm_reader = mix
            .outro_bgm
            .as_ref()
            .and_then(|a| WavStreamReader::open(&a.resolved_wav_path, a.wav_header.clone()).ok());
        let n_tr = mix.tracks.len();

        Self {
            mix,
            track_readers,
            intro_vo_reader,
            intro_bgm_reader,
            outro_bgm_reader,
            track_bufs,
            xfade_bufs,
            aux_buf: Vec::with_capacity(RENDER_CHUNK_FRAMES),
            bgm_buf: Vec::with_capacity(RENDER_CHUNK_FRAMES),
            hp_x1: vec![0.0_f32; n_tr],
            hp_y1: vec![0.0_f32; n_tr],
            noise_floor: vec![0.0025_f32; n_tr],
            hold_frames_rem: vec![0usize; n_tr],
        }
    }

    fn find_region_index(&self, frame: u64) -> usize {
        let idx = self.mix.regions.partition_point(|r| r.edit_end_frame <= frame);
        idx.min(self.mix.regions.len().saturating_sub(1))
    }

    fn mix_tracks_at_source_run(
        &mut self,
        src_start_frame: u64,
        len: usize,
        gate_g: &mut [f32],
        allow_automix: bool,
        out_mix: &mut [f32],
    ) {
        out_mix[..len].fill(0.0);
        let num_tracks = self.mix.tracks.len();
        if num_tracks == 0 || len == 0 {
            return;
        }

        let mut active_track_count = 0usize;
        for (ti, tr) in self.mix.tracks.iter().enumerate() {
            if !tr.muted_or_unsoloed {
                active_track_count += 1;
            }
            if let Some(reader) = self.track_readers[ti].as_mut() {
                let adj = (src_start_frame as i64 - tr.offset_frames).max(0) as u64;
                let buf = &mut self.track_bufs[ti][..len];
                reader.read_mono_48k(adj, buf);
                // Per-track 85Hz 1st-order high-pass filter: removes AC rumble, mic-stand thumps,
                // muddy same-room low-end echo & preamp DC offset cleanly.
                let mut x1 = self.hp_x1[ti];
                let mut y1 = self.hp_y1[ti];
                for s in buf.iter_mut() {
                    let x = *s;
                    let y = HPF_85HZ_ALPHA * (y1 + x - x1);
                    x1 = x;
                    y1 = y;
                    *s = y;
                }
                self.hp_x1[ti] = x1;
                self.hp_y1[ti] = y1;
            } else {
                self.track_bufs[ti][..len].fill(0.0);
            }
        }

        let use_automix = allow_automix
            && active_track_count > 1
            && self.mix.auto_solo_mode != "off";

        // Fast 2.5ms gate-open attack preserves consonant onsets; 45ms smooth release prevents pumping
        let coeff_att = 1.0 / (0.0025 * MIX_SAMPLE_RATE_F64 as f32);
        let coeff_rel = 1.0 / (0.045 * MIX_SAMPLE_RATE_F64 as f32);
        // Deep attenuation for cross-mic room bleed/echo & low-level noise floor on non-speaking tracks
        let single_bleed_gain = if self.mix.auto_solo_mode == "hard_mute" {
            0.02
        } else {
            (self.mix.duck_linear * 0.45).clamp(0.045, 0.095)
        };
        let idle_noise_gain: f32 = if self.mix.auto_solo_mode == "hard_mute" {
            0.18
        } else {
            0.28
        };

        // Evaluate in 10ms (480-sample) windows with 5ms lookahead for zero clipped plosives
        let mut pos = 0usize;
        while pos < len {
            let sub_end = (pos + SUB_WINDOW_FRAMES).min(len);
            let sub_len = sub_end - pos;
            let look_end = (sub_end + LOOKAHEAD_FRAMES).min(len);
            let look_len = (look_end - pos).max(1);
            let cur_src_frame = src_start_frame + pos as u64;
            let src_ms = ((cur_src_frame as i64) * 1000) / (MIX_SAMPLE_RATE as i64);

            let is_laughter = range_contains_with_margin(&self.mix.laughter_ranges, src_ms, 80, 180);

            // Measure real 48kHz PCM RMS (with 5ms lookahead peak RMS) & adaptive floor per track
            let mut rms_list = [0.0_f32; 16];
            let mut rms_look_list = [0.0_f32; 16];
            let mut is_primary = [false; 16];
            let mut any_primary = false;
            let mut max_rms = 0.0_f32;
            let bounded_tracks = num_tracks.min(16);

            if use_automix {
                for ti in 0..bounded_tracks {
                    let tr = &self.mix.tracks[ti];
                    if tr.muted_or_unsoloed {
                        continue;
                    }
                    let buf = &self.track_bufs[ti];
                    let mut sq_cur = 0.0_f64;
                    for &s in &buf[pos..sub_end] {
                        let gs = (s * tr.base_gain) as f64;
                        sq_cur += gs * gs;
                    }
                    let mut sq_look = 0.0_f64;
                    for &s in &buf[sub_end..look_end] {
                        let gs = (s * tr.base_gain) as f64;
                        sq_look += gs * gs;
                    }
                    let rms_cur = (sq_cur / (sub_len.max(1) as f64)).sqrt() as f32;
                    let look_tail_len = look_len.saturating_sub(sub_len);
                    let rms_ahead = if look_tail_len > 0 {
                        (sq_look / (look_tail_len as f64)).sqrt() as f32
                    } else {
                        rms_cur
                    };
                    let rms_eff = rms_cur.max(rms_ahead);
                    rms_list[ti] = rms_cur;
                    rms_look_list[ti] = rms_eff;
                    if rms_eff > max_rms {
                        max_rms = rms_eff;
                    }

                    // Adaptive minimum-statistics noise floor estimator (clamped to <= -42 dBFS)
                    if rms_cur < self.noise_floor[ti] {
                        self.noise_floor[ti] = (0.75 * self.noise_floor[ti] + 0.25 * rms_cur).max(0.0002);
                    } else if rms_cur < 0.016 {
                        self.noise_floor[ti] =
                            (0.992 * self.noise_floor[ti] + 0.008 * rms_cur).min(0.008);
                    }

                    let track_ms = (((cur_src_frame as i64 - tr.offset_frames).max(0)) * 1000)
                        / (MIX_SAMPLE_RATE as i64);
                    if range_contains_with_margin(&tr.primary_intervals, track_ms, 120, 260) {
                        is_primary[ti] = true;
                        any_primary = true;
                    }
                }
            }

            // Compute target gates:
            // - Distinguish genuine speech vs same-room acoustic room echo/bleed using cross-track dominance ratio
            // - Suppress echo & idle preamp hiss deeply when 1 person speaks while keeping overlaps intact
            let mut targets = [1.0_f32; 16];
            if use_automix {
                for ti in 0..bounded_tracks {
                    let tr = &self.mix.tracks[ti];
                    if tr.muted_or_unsoloed {
                        targets[ti] = 0.0;
                        continue;
                    }
                    let track_ms = (((cur_src_frame as i64 - tr.offset_frames).max(0)) * 1000)
                        / (MIX_SAMPLE_RATE as i64);
                    let transcript_active = range_contains_with_margin(
                        &tr.active_intervals,
                        track_ms,
                        80,
                        180,
                    );
                    let eff_rms = rms_look_list[ti];
                    let floor_thr = (self.noise_floor[ti] * 3.1).max(0.011);
                    let dom_ratio = if max_rms > 1e-6 {
                        eff_rms / max_rms
                    } else {
                        1.0
                    };
                    // A track is genuinely voiced iff it beats its noise floor AND isn't mere room bleed
                    // (< 35% of another loud speaker's RMS, which is physically ~9dB+ quieter cross-mic echo!)
                    let acoustic_indep_speech = eff_rms >= floor_thr && (max_rms < 0.018 || dom_ratio >= 0.35);

                    if any_primary {
                        if is_primary[ti] {
                            targets[ti] = if eff_rms >= floor_thr * 0.7 || transcript_active {
                                1.0
                            } else {
                                idle_noise_gain.max(0.45)
                            };
                        } else if max_rms >= 0.016 && dom_ratio < 0.35 {
                            // Room echo/bleed from primary speaker on another track -> suppress deeply!
                            self.hold_frames_rem[ti] = 0;
                            targets[ti] = single_bleed_gain;
                        } else if eff_rms >= 0.014 || (transcript_active && eff_rms >= 0.008) {
                            // Other speaker has genuine speech -> keep full volume for editor to handle
                            self.hold_frames_rem[ti] = 7_680;
                            targets[ti] = 1.0;
                        } else if self.hold_frames_rem[ti] > 0 && dom_ratio >= 0.22 {
                            self.hold_frames_rem[ti] = self.hold_frames_rem[ti].saturating_sub(sub_len);
                            targets[ti] = 1.0;
                        } else {
                            // Low-level noise floor on non-primary track -> suppress
                            self.hold_frames_rem[ti] = 0;
                            targets[ti] = single_bleed_gain;
                        }
                    } else if is_laughter {
                        targets[ti] = if eff_rms >= floor_thr * 0.8 || dom_ratio >= 0.28 {
                            1.0
                        } else {
                            single_bleed_gain
                        };
                    } else if max_rms >= 0.014 {
                        if dom_ratio >= 0.70 || acoustic_indep_speech {
                            self.hold_frames_rem[ti] = 7_680; // 160ms hold avoids word-tail chopping
                            targets[ti] = 1.0;
                        } else if self.hold_frames_rem[ti] > 0 && dom_ratio >= 0.22 {
                            self.hold_frames_rem[ti] = self.hold_frames_rem[ti].saturating_sub(sub_len);
                            targets[ti] = 1.0;
                        } else {
                            // Other mics picking up room echo/bleed & noise while 1 person speaks!
                            self.hold_frames_rem[ti] = 0;
                            targets[ti] = single_bleed_gain;
                        }
                    } else {
                        // All tracks quiet -> downward noise expander gently reduces multi-mic hiss
                        self.hold_frames_rem[ti] = self.hold_frames_rem[ti].saturating_sub(sub_len);
                        targets[ti] = if self.hold_frames_rem[ti] > 0 {
                            1.0
                        } else {
                            idle_noise_gain
                        };
                    }
                }
            }

            // Sum tracks sample-by-sample with smooth slew, explicit track mutes & transient mouth-click tamer
            for ti in 0..num_tracks {
                let tr = &self.mix.tracks[ti];
                if tr.muted_or_unsoloed {
                    continue;
                }
                let track_ms = (((cur_src_frame as i64 - tr.offset_frames).max(0)) * 1000)
                    / (MIX_SAMPLE_RATE as i64);
                let manual_mute_gain = track_mute_gain_at(&tr.track_mutes, track_ms);
                let in_mouth_click = self.mix.de_click_enabled
                    && range_contains_with_margin(&tr.mouth_click_ranges, track_ms, 0, 0);

                // Measure click-window peak vs window RMS for transient impulse taming (preserves room tone & speech!)
                let mut click_tame_gain = 1.0_f32;
                if in_mouth_click {
                    let mut sq = 0.0_f32;
                    let mut pk = 0.0_f32;
                    for &s in &self.track_bufs[ti][pos..sub_end] {
                        let a = s.abs();
                        sq += s * s;
                        if a > pk {
                            pk = a;
                        }
                    }
                    let win_rms = (sq / (sub_len.max(1) as f32)).sqrt();
                    if win_rms < 0.022 && pk > win_rms * 3.4 && pk > 0.012 {
                        let ceiling = (win_rms * 1.45).max(0.004);
                        let raw_ratio = (ceiling / pk).clamp(0.18, 1.0);
                        click_tame_gain = if self.mix.de_click_strong {
                            raw_ratio
                        } else {
                            raw_ratio.max(0.32)
                        };
                    }
                }

                let tgt = if ti < 16 { targets[ti] } else { 1.0 };
                let mut g = if gate_g[ti] < 0.0 { tgt } else { gate_g[ti] };
                let coeff = if tgt > g { coeff_att } else { coeff_rel };
                let gain_static = tr.base_gain * manual_mute_gain * click_tame_gain;

                let src_slice = &self.track_bufs[ti][pos..sub_end];
                let dst_slice = &mut out_mix[pos..sub_end];
                for i in 0..sub_len {
                    g += coeff * (tgt - g);
                    dst_slice[i] += src_slice[i] * gain_static * g;
                }
                gate_g[ti] = g;
            }

            // Apply 1kHz Bleep redactions with smooth 10ms fade (global source position synced)
            if range_contains_with_margin(&self.mix.bleep_ranges, src_ms, 15, 15) {
                let amp = db_to_linear(-14.0);
                for i in 0..sub_len {
                    let gf = src_start_frame + (pos + i) as u64;
                    let ms_i = ((gf as i64) * 1000) / (MIX_SAMPLE_RATE as i64);
                    if range_contains_with_margin(&self.mix.bleep_ranges, ms_i, 0, 0) {
                        let phase = 2.0 * std::f64::consts::PI * 1000.0 * ((gf as f64) / MIX_SAMPLE_RATE_F64);
                        out_mix[pos + i] = (phase.sin() as f32) * amp;
                    }
                }
            }

            pos = sub_end;
        }
    }

    fn render_chunk_s16le(&mut self, start_frame: u64, frame_count: usize, out_pcm: &mut Vec<u8>) {
        out_pcm.clear();
        if frame_count == 0 {
            return;
        }
        out_pcm.resize(frame_count * 2, 0);

        let raw_eval_start = start_frame.saturating_sub(PREROLL_FRAMES);
        let eval_start = (raw_eval_start / SUB_WINDOW_FRAMES as u64) * (SUB_WINDOW_FRAMES as u64);
        let eval_end = (start_frame + frame_count as u64).min(self.mix.total_frames);
        if eval_end <= eval_start {
            return;
        }
        let total_eval = (eval_end - eval_start) as usize;
        let skip_preroll = (start_frame - eval_start) as usize;

        let mut voice_eval = vec![0.0_f32; total_eval];
        let mut voice_active_eval = vec![false; total_eval];
        let mut bgm_eval = vec![0.0_f32; total_eval];

        self.hp_x1.fill(0.0);
        self.hp_y1.fill(0.0);
        self.noise_floor.fill(0.0025);
        self.hold_frames_rem.fill(0);

        let mut gate_g = vec![-1.0_f32; self.mix.tracks.len()];
        let mut xfade_gate_g = vec![1.0_f32; self.mix.tracks.len()];
        let mut tail_hp_x1 = vec![0.0_f32; self.mix.tracks.len()];
        let mut tail_hp_y1 = vec![0.0_f32; self.mix.tracks.len()];

        // 1. Evaluate Regions (Cold Open, Fixed Intro VO, Body PlaybackSpans with 24ms Equal-Power Crossfade)
        let mut cursor_frame = eval_start;
        while cursor_frame < eval_end {
            let reg_idx = self.find_region_index(cursor_frame);
            if self.mix.regions.is_empty() {
                break;
            }
            let reg = self.mix.regions[reg_idx].clone();
            let seg_end = eval_end.min(reg.edit_end_frame);
            if seg_end <= cursor_frame {
                cursor_frame += 1;
                continue;
            }
            let seg_len = (seg_end - cursor_frame) as usize;
            let eval_off = (cursor_frame - eval_start) as usize;

            match reg.kind {
                TimelineRegionKind::IdleGap => {
                    // Natural silence between cold-open clips (BGM still breathes underneath)
                }
                TimelineRegionKind::IntroVoSlice => {
                    self.aux_buf.resize(seg_len, 0.0);
                    if let Some(vo_reader) = self.intro_vo_reader.as_mut() {
                        let vo_pos = cursor_frame.saturating_sub(reg.edit_start_frame);
                        vo_reader.read_mono_48k(vo_pos, &mut self.aux_buf[..seg_len]);
                    } else {
                        self.aux_buf[..seg_len].fill(0.0);
                    }
                    let reg_len = reg.edit_end_frame.saturating_sub(reg.edit_start_frame);
                    let fade_f = 720u64.min(reg_len / 4); // 15ms fade
                    for k in 0..seg_len {
                        let local_f = (cursor_frame + k as u64) - reg.edit_start_frame;
                        let mut env = 0.94_f32;
                        if fade_f > 0 && local_f < fade_f {
                            env *= (local_f as f32) / (fade_f as f32);
                        } else if fade_f > 0 && local_f >= reg_len.saturating_sub(fade_f) {
                            env *= ((reg_len - local_f) as f32) / (fade_f as f32);
                        }
                        voice_eval[eval_off + k] = self.aux_buf[k] * env;
                        voice_active_eval[eval_off + k] = true;
                    }
                }
                TimelineRegionKind::HighlightSlice {
                    source_start_frame,
                    slice_frames,
                } => {
                    let local_start = cursor_frame.saturating_sub(reg.edit_start_frame);
                    let mut done = 0usize;
                    while done < seg_len {
                        let chunk = (seg_len - done).min(RENDER_CHUNK_FRAMES);
                        let src_f = source_start_frame + local_start + done as u64;
                        self.mix_tracks_at_source_run(
                            src_f,
                            chunk,
                            &mut gate_g,
                            true,
                            &mut voice_eval[eval_off + done..eval_off + done + chunk],
                        );
                        let fade_f = 1_152u64.min(slice_frames / 4);
                        for j in 0..chunk {
                            let lf = local_start + (done + j) as u64;
                            let mut env = 1.0_f32;
                            if fade_f > 0 && lf < fade_f {
                                let p = (lf as f32) / (fade_f as f32);
                                env = (p * FRAC_PI_2).sin();
                            } else if fade_f > 0 && lf >= slice_frames.saturating_sub(fade_f) {
                                let rem = slice_frames.saturating_sub(lf);
                                let p = (rem as f32) / (fade_f as f32);
                                env = (p * FRAC_PI_2).sin();
                            }
                            voice_eval[eval_off + done + j] *= env;
                            voice_active_eval[eval_off + done + j] = true;
                        }
                        done += chunk;
                    }
                }
                TimelineRegionKind::BodySpan {
                    source_start_frame,
                    prev_source_end_frame,
                    xfade_frames,
                    splice_corr,
                } => {
                    let local_start = cursor_frame.saturating_sub(reg.edit_start_frame);
                    let mut done = 0usize;
                    while done < seg_len {
                        let chunk = (seg_len - done).min(RENDER_CHUNK_FRAMES);
                        let lf_start = local_start + done as u64;
                        let src_f = source_start_frame + lf_start;

                        // Snapshot outgoing track gates & HPF state BEFORE running incoming span
                        // so crossfade tail seamlessly preserves outgoing tone without a gate step!
                        let in_crossfade = prev_source_end_frame.is_some()
                            && xfade_frames > 0
                            && lf_start < xfade_frames;
                        if in_crossfade {
                            xfade_gate_g.copy_from_slice(&gate_g);
                            tail_hp_x1.copy_from_slice(&self.hp_x1);
                            tail_hp_y1.copy_from_slice(&self.hp_y1);
                        }

                        self.mix_tracks_at_source_run(
                            src_f,
                            chunk,
                            &mut gate_g,
                            true,
                            &mut voice_eval[eval_off + done..eval_off + done + chunk],
                        );

                        // Apply 36ms phase-aligned adaptive equal-power crossfade across cut boundary
                        if let Some(prev_end_f) = prev_source_end_frame {
                            if in_crossfade {
                                let xf_avail = ((xfade_frames - lf_start) as usize).min(chunk);
                                let mut out_tail = vec![0.0_f32; xf_avail];
                                let tail_src_f = prev_end_f + lf_start;
                                for (ti, tr) in self.mix.tracks.iter().enumerate() {
                                    if tr.muted_or_unsoloed {
                                        continue;
                                    }
                                    if let Some(reader) = self.track_readers[ti].as_mut() {
                                        self.xfade_bufs[ti].resize(xf_avail, 0.0);
                                        let adj = (tail_src_f as i64 - tr.offset_frames).max(0) as u64;
                                        reader.read_mono_48k(adj, &mut self.xfade_bufs[ti][..xf_avail]);
                                        let g_state = if xfade_gate_g[ti] < 0.0 {
                                            1.0
                                        } else {
                                            xfade_gate_g[ti]
                                        };
                                        let mut x1 = tail_hp_x1[ti];
                                        let mut y1 = tail_hp_y1[ti];
                                        for j in 0..xf_avail {
                                            let x = self.xfade_bufs[ti][j];
                                            let y = HPF_85HZ_ALPHA * (y1 + x - x1);
                                            x1 = x;
                                            y1 = y;
                                            let t_ms = (((tail_src_f + j as u64) as i64 - tr.offset_frames).max(0) * 1000)
                                                / (MIX_SAMPLE_RATE as i64);
                                            let mg = track_mute_gain_at(&tr.track_mutes, t_ms);
                                            out_tail[j] += y * tr.base_gain * g_state * mg;
                                        }
                                    }
                                }
                                let alpha = splice_corr.clamp(0.0, 1.0);
                                for j in 0..xf_avail {
                                    let lf = lf_start + j as u64;
                                    let p = (lf as f32 + 0.5) / (xfade_frames as f32);
                                    let theta = p * FRAC_PI_2;
                                    let w_out = (1.0 - alpha) * theta.cos() + alpha * (1.0 - p);
                                    let w_in = (1.0 - alpha) * theta.sin() + alpha * p;
                                    let in_s = voice_eval[eval_off + done + j];
                                    voice_eval[eval_off + done + j] =
                                        out_tail[j] * w_out + in_s * w_in;
                                }
                            }
                        }

                        voice_active_eval[eval_off + done..eval_off + done + chunk].fill(true);
                        done += chunk;
                    }
                }
            }

            cursor_frame = seg_end;
        }

        // 2. Render Intro BGM & Outro BGM Beds with Smooth Sidechain Ducking
        if self.intro_bgm_reader.is_some() || self.outro_bgm_reader.is_some() {
            let mut bgm_duck_g = 1.0_f32;
            let duck_att = 1.0 / (0.045 * MIX_SAMPLE_RATE_F64 as f32);
            let duck_rel = 1.0 / (0.350 * MIX_SAMPLE_RATE_F64 as f32);

            // Intro BGM [0 .. intro_end_frame]
            if eval_start <= self.mix.intro_end_frame {
                if let (Some(bgm_asset), Some(reader)) =
                    (&self.mix.intro_bgm, self.intro_bgm_reader.as_mut())
                {
                    let overlap_end = eval_end.min(self.mix.intro_end_frame);
                    let count = overlap_end.saturating_sub(eval_start) as usize;
                    if count > 0 {
                        let loop_len = bgm_asset.frames_48k.max(MIX_SAMPLE_RATE as u64);
                        self.bgm_buf.resize(count, 0.0);
                        let start_mod = eval_start % loop_len;
                        let first_part = ((loop_len - start_mod) as usize).min(count);
                        reader.read_mono_48k(start_mod, &mut self.bgm_buf[..first_part]);
                        if first_part < count {
                            reader.read_mono_48k(0, &mut self.bgm_buf[first_part..count]);
                        }
                        // 默认淡入淡出 800ms
                        let fade_in_frames = (0.8 * MIX_SAMPLE_RATE_F64) as u64;
                        let fade_out_frames = (0.8 * MIX_SAMPLE_RATE_F64) as u64;
                        for i in 0..count {
                            let f = eval_start + i as u64;
                            let mut fade = 1.0_f32;
                            if f < fade_in_frames {
                                fade = (f as f32) / (fade_in_frames as f32);
                            } else if f > self.mix.intro_end_frame.saturating_sub(fade_out_frames) {
                                fade = ((self.mix.intro_end_frame.saturating_sub(f)) as f32) / (fade_out_frames as f32);
                            }
                            bgm_eval[i] += self.bgm_buf[i] * 0.45 * fade.clamp(0.0, 1.0);
                        }
                    }
                }
            }

            // Outro BGM [outro_start_frame .. total_frames]
            if eval_end > self.mix.outro_start_frame {
                if let (Some(bgm_asset), Some(reader)) =
                    (&self.mix.outro_bgm, self.outro_bgm_reader.as_mut())
                {
                    let ov_start = eval_start.max(self.mix.outro_start_frame);
                    let count = eval_end.saturating_sub(ov_start) as usize;
                    if count > 0 {
                        let loop_len = bgm_asset.frames_48k.max(MIX_SAMPLE_RATE as u64);
                        let rel_start = ov_start - self.mix.outro_start_frame;
                        let start_mod = rel_start % loop_len;
                        self.bgm_buf.resize(count, 0.0);
                        let first_part = ((loop_len - start_mod) as usize).min(count);
                        reader.read_mono_48k(start_mod, &mut self.bgm_buf[..first_part]);
                        if first_part < count {
                            reader.read_mono_48k(0, &mut self.bgm_buf[first_part..count]);
                        }
                        let fade_in_frames = (2.5 * MIX_SAMPLE_RATE_F64) as f32;
                        let ev_off = (ov_start - eval_start) as usize;
                        for i in 0..count {
                            let lf = (rel_start + i as u64) as f32;
                            let fade = (lf / fade_in_frames).clamp(0.15, 1.0);
                            bgm_eval[ev_off + i] += self.bgm_buf[i] * 0.45 * fade;
                        }
                    }
                }
            }

            // Apply BGM sidechain envelope driven by voice signal envelope
            // 片头金句整段闪避（不考虑段内的音量连续）：在金句播放区间持续闪避
            for i in 0..total_eval {
                let frame_idx = eval_start + i as u64;
                let in_quotes = self.mix.cold_quotes_range.map_or(false, |(qs, qe)| frame_idx >= qs && frame_idx <= qe);
                let voice_present = in_quotes || (voice_active_eval[i] && voice_eval[i].abs() > 0.012);
                let tgt = if voice_present {
                    self.mix.bgm_duck_linear
                } else {
                    1.0
                };
                let c = if tgt < bgm_duck_g { duck_att } else { duck_rel };
                bgm_duck_g += c * (tgt - bgm_duck_g);
                bgm_eval[i] *= bgm_duck_g;
            }
        }

        // 3. Final Soft-Knee Limiter & s16le Conversion (skipping preroll!)
        let copy_len = frame_count.min(total_eval.saturating_sub(skip_preroll));
        for i in 0..copy_len {
            let ei = skip_preroll + i;
            let mut s = voice_eval[ei] + bgm_eval[ei];
            if s.abs() > 0.85 {
                let excess = (s.abs() - 0.85) / 0.15;
                s = s.signum() * (0.85 + 0.15 * excess.tanh());
            }
            let sample_i16 = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
            let bytes = sample_i16.to_le_bytes();
            out_pcm[i * 2] = bytes[0];
            out_pcm[i * 2 + 1] = bytes[1];
        }
    }
}

pub fn stream_live_mix_range(
    stream: &mut TcpStream,
    mix: &PreparedLiveMix,
    start: u64,
    end: u64,
    is_head: bool,
) {
    if is_head {
        return;
    }

    // Write any portion overlapping the 44-byte RIFF WAV header
    let mut cursor = start;
    if cursor < WAV_HEADER_LEN {
        let hdr_end = (end + 1).min(WAV_HEADER_LEN) as usize;
        if stream
            .write_all(&mix.wav_header_bytes[cursor as usize..hdr_end])
            .is_err()
        {
            return;
        }
        cursor = hdr_end as u64;
    }

    if cursor > end || mix.total_frames == 0 {
        return;
    }

    let mut session = LiveMixRenderSession::open(mix);
    let mut pcm_chunk = Vec::with_capacity(RENDER_CHUNK_FRAMES * 2);

    while cursor <= end {
        let pcm_byte_off = cursor - WAV_HEADER_LEN;
        let frame_start = pcm_byte_off / 2;
        if frame_start >= mix.total_frames {
            break;
        }
        let rem_bytes_requested = end - cursor + 1;
        let frames_needed = (((pcm_byte_off % 2) + rem_bytes_requested + 1) / 2)
            .min(RENDER_CHUNK_FRAMES as u64)
            .min(mix.total_frames - frame_start) as usize;
        if frames_needed == 0 {
            break;
        }

        session.render_chunk_s16le(frame_start, frames_needed, &mut pcm_chunk);
        let skip_first_byte = (pcm_byte_off % 2) as usize;
        let avail_bytes = pcm_chunk.len().saturating_sub(skip_first_byte);
        let send_bytes = avail_bytes.min(rem_bytes_requested as usize);
        if send_bytes == 0 {
            break;
        }
        if stream
            .write_all(&pcm_chunk[skip_first_byte..skip_first_byte + send_bytes])
            .is_err()
        {
            // Browser/AVFoundation cancelled the partial stream request — exit immediately
            break;
        }
        cursor += send_bytes as u64;
    }
}
