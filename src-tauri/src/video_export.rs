use crate::audio_dsp::find_ffmpeg_bin;
use crate::models::{EdlKeepSegment, TrackInspectionResult};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReaperRequest {
    pub output_rpp_path: String,
    pub project_title: String,
    pub tracks: Vec<TrackInspectionResult>,
    pub keep_segments: Vec<EdlKeepSegment>,
}

pub fn export_reaper_rpp(req: &ExportReaperRequest) -> Result<String, String> {
    if let Some(parent) = Path::new(&req.output_rpp_path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut rpp = String::new();
    rpp.push_str("<REAPER_PROJECT 0.1 \"7.0\" 1730000000\n");
    rpp.push_str("  SAMPLERATE 48000 0 0\n");

    for tr in req.tracks.iter().filter(|t| !t.is_ref) {
        rpp.push_str("  <TRACK\n");
        rpp.push_str(&format!("    NAME \"{} ({})\"\n", tr.name, tr.role));
        let vol_linear = 10.0_f64.powf(tr.auto_gain_db / 20.0);
        rpp.push_str(&format!("    VOLPAN {:.4} 0 -1 -1 1\n", vol_linear));

        let mut timeline_pos_sec = 0.0_f64;
        for seg in &req.keep_segments {
            let src_start_sec = ((seg.source_start_ms - tr.sync_offset_ms).max(0) as f64) / 1000.0;
            let len_sec = ((seg.source_end_ms - seg.source_start_ms).max(10) as f64) / 1000.0;
            let xfade_sec = (seg.crossfade_ms.clamp(10, 80) as f64) / 1000.0;

            rpp.push_str("    <ITEM\n");
            rpp.push_str(&format!("      POSITION {:.4}\n", timeline_pos_sec));
            rpp.push_str(&format!("      LENGTH {:.4}\n", len_sec));
            rpp.push_str(&format!("      SOFFS {:.4}\n", src_start_sec));
            rpp.push_str(&format!("      FADEIN 1 {:.4} 0 1 0 0 0\n", xfade_sec));
            rpp.push_str(&format!("      FADEOUT 1 {:.4} 0 1 0 0 0\n", xfade_sec));
            rpp.push_str("      <SOURCE WAVE\n");
            rpp.push_str(&format!("        FILE \"{}\"\n", tr.normalized_wav_path));
            rpp.push_str("      >\n");
            rpp.push_str("    >\n");

            timeline_pos_sec += len_sec + (seg.pause_after_ms.max(0) as f64) / 1000.0;
        }

        rpp.push_str("  >\n");
    }

    rpp.push_str(">\n");
    fs::write(&req.output_rpp_path, rpp).map_err(|e| e.to_string())?;
    Ok(req.output_rpp_path.clone())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuxWeChatVideoRequest {
    pub output_mp4_path: String,
    pub fps: u32,
    pub png_frames_base64: Vec<String>,
    pub audio_wav_path: Option<String>,
}

pub fn mux_wechat_mp4(req: &MuxWeChatVideoRequest) -> Result<String, String> {
    if req.png_frames_base64.is_empty() {
        return Err("没有可编码的视频帧".into());
    }
    let out_path = Path::new(&req.output_mp4_path);
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let tmp_dir = out_path
        .parent()
        .unwrap_or_else(|| Path::new("/tmp"))
        .join(format!(".podcraft_vframes_{}", std::process::id()));
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    for (idx, b64) in req.png_frames_base64.iter().enumerate() {
        let stripped = b64
            .strip_prefix("data:image/png;base64,")
            .unwrap_or(b64.as_str());
        let bytes = BASE64
            .decode(stripped)
            .map_err(|e| format!("Invalid base64 frame {}: {}", idx, e))?;
        let frame_path = tmp_dir.join(format!("frame_{:05}.png", idx));
        fs::write(frame_path, bytes).map_err(|e| e.to_string())?;
    }

    let pattern = tmp_dir.join("frame_%05d.png").to_string_lossy().to_string();
    let fps_str = req.fps.max(1).to_string();

    let run_encode = |vcodec: &str| -> Result<bool, String> {
        let mut cmd = Command::new(find_ffmpeg_bin());
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .args(["-nostdin", "-loglevel", "error", "-y", "-framerate", &fps_str, "-i", &pattern]);
        if let Some(ref audio) = req.audio_wav_path {
            if Path::new(audio).exists() {
                cmd.args(["-i", audio, "-shortest", "-c:a", "aac", "-b:a", "192k"]);
            }
        }
        cmd.args(["-c:v", vcodec, "-pix_fmt", "yuv420p", &req.output_mp4_path]);
        let output = cmd.output().map_err(|e| e.to_string())?;
        Ok(output.status.success())
    };

    let ok = run_encode("h264_videotoolbox").unwrap_or(false) || run_encode("libx264")?;
    let _ = fs::remove_dir_all(&tmp_dir);

    if !ok {
        return Err("FFmpeg 合成竖版 MP4 失败".into());
    }
    Ok(req.output_mp4_path.clone())
}
