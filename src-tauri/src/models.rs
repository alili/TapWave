use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRangeMs {
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedSpeechSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub is_silence: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerTrackInput {
    pub id: String,
    pub name: String,
    pub role: String, // "host" | "co_host" | "guest" | "ref"
    pub color: String,
    pub file_path: String,
    pub is_ref: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInspectionResult {
    pub id: String,
    pub name: String,
    pub role: String,
    pub color: String,
    pub normalized_wav_path: String,
    pub duration_ms: i64,
    pub sync_offset_ms: i64,
    pub drift_ratio: f64,
    pub measured_lufs: f64,
    pub auto_gain_db: f64,
    pub room_tone_range_ms: TimeRangeMs,
    pub peaks: Vec<f32>,
    #[serde(default)]
    pub detected_segments: Vec<DetectedSpeechSegment>,
    pub is_ref: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectProjectRequest {
    pub recording_mode: String, // "same_room_sync" | "multi_device_align"
    pub tracks: Vec<SpeakerTrackInput>,
    pub work_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgressPayload {
    pub stage: String,
    pub completed: usize,
    pub total: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveVoiceInterval {
    pub track_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub is_laughter_or_overlap: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionSpanSpec {
    pub start_ms: i64,
    pub end_ms: i64,
    pub style: String, // "sine_1khz_bleep" | "reverse_blur" | "room_tone_mute"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMuteRangeSpec {
    pub track_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdlKeepSegment {
    pub source_start_ms: i64,
    pub source_end_ms: i64,
    pub crossfade_ms: i64,
    pub pause_after_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightClipSpec {
    pub source_start_ms: i64,
    pub source_end_ms: i64,
    #[serde(default)]
    pub muted_track_ids: Vec<String>,
}

fn default_gap_ms() -> i64 {
    650
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColdOpenRenderSpec {
    pub enabled: bool,
    pub clips: Vec<HighlightClipSpec>,
    pub bgm_wav_path: Option<String>,
    pub intro_lead_in_ms: i64,
    pub outro_tail_ms: i64,
    pub normal_gain_db: f64,
    pub ducked_gain_db: f64,
    #[serde(default = "default_gap_ms")]
    pub gap_ms: i64,
    #[serde(default)]
    pub intro_vo_wav_path: Option<String>,
    #[serde(default)]
    pub intro_vo_start_offset_ms: Option<i64>,
    #[serde(default)]
    pub intro_bgm_duration_ms: Option<i64>,
    #[serde(default)]
    pub intro_bgm_fade_in_ms: Option<i64>,
    #[serde(default)]
    pub intro_bgm_fade_out_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderMixRequest {
    pub output_path: String,
    pub target_lufs: f64,
    pub auto_solo_mode: String, // "off" | "natural_ducking" | "hard_mute"
    pub duck_attenuation_db: f64,
    pub loudness_align_enabled: bool,
    #[serde(default)]
    pub de_click_enabled: bool,
    #[serde(default)]
    pub de_click_strength: String,
    pub tracks: Vec<TrackInspectionResult>,
    pub active_intervals: Vec<ActiveVoiceInterval>,
    #[serde(default)]
    pub primary_intervals: Vec<TrackMuteRangeSpec>,
    pub track_mutes: Vec<TrackMuteRangeSpec>,
    pub redactions: Vec<RedactionSpanSpec>,
    pub keep_segments: Vec<EdlKeepSegment>,
    pub cold_open: ColdOpenRenderSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderMixResponse {
    pub output_path: String,
    pub duration_ms: i64,
    pub cold_open_duration_ms: i64,
}
