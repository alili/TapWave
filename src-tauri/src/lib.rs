pub mod audio_dsp;
pub mod live_mix_stream;
pub mod models;
pub mod video_export;

use audio_dsp::{
    find_ffmpeg_bin, inspect_and_align_project_with_progress, render_master_podcast_mix,
};
use live_mix_stream::{get_live_mix, register_live_mix, stream_live_mix_range, LiveMixSpec, MIX_SAMPLE_RATE};
use models::{
    ImportProgressPayload, InspectProjectRequest, RenderMixRequest, RenderMixResponse,
    TrackInspectionResult,
};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};
use video_export::{export_reaper_rpp, mux_wechat_mp4, ExportReaperRequest, MuxWeChatVideoRequest};

static AUDIO_HTTP_PORT: OnceLock<u16> = OnceLock::new();
static CUSTOM_MODELS_DIR: OnceLock<std::sync::RwLock<Option<PathBuf>>> = OnceLock::new();
static SIDECAR_CHILD_PID: OnceLock<std::sync::Mutex<Option<u32>>> = OnceLock::new();
static PENDING_OPEN_FILE: OnceLock<std::sync::Mutex<Option<String>>> = OnceLock::new();

fn get_pending_open_file_lock() -> &'static std::sync::Mutex<Option<String>> {
    PENDING_OPEN_FILE.get_or_init(|| std::sync::Mutex::new(None))
}

fn get_sidecar_child_pid_lock() -> &'static std::sync::Mutex<Option<u32>> {
    SIDECAR_CHILD_PID.get_or_init(|| std::sync::Mutex::new(None))
}

fn get_custom_models_dir_lock() -> &'static std::sync::RwLock<Option<PathBuf>> {
    CUSTOM_MODELS_DIR.get_or_init(|| std::sync::RwLock::new(None))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiLoadProgressEvent {
    percent: u8,
    stage: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependenciesStatusDto {
    pub has_python: bool,
    pub python_bin: String,
    pub has_sidecar: bool,
    pub sidecar_path: Option<String>,
    pub models_dir: String,
    pub has_sense_voice: bool,
    pub has_silero_vad: bool,
    pub has_paraformer: bool,
    pub models_ready: bool,
    pub missing_models: Vec<String>,
    pub recommended_mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadProgressPayload {
    pub percent: u8,
    pub stage: String,
    pub message: String,
    pub is_done: bool,
    pub error: Option<String>,
}

fn get_user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn find_python_bin() -> String {
    let mut candidates = Vec::new();
    if let Some(home_path) = get_user_home_dir() {
        #[cfg(windows)]
        {
            candidates.push(home_path.join(".tapwave/venv/Scripts/python.exe"));
            candidates.push(home_path.join(".podcraft/venv/Scripts/python.exe"));
        }
        #[cfg(not(windows))]
        {
            candidates.push(home_path.join(".tapwave/venv/bin/python3"));
            candidates.push(home_path.join(".tapwave/venv/bin/python"));
            candidates.push(home_path.join(".podcraft/venv/bin/python3"));
            candidates.push(home_path.join(".podcraft/venv/bin/python"));
        }
    }
    #[cfg(windows)]
    {
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.venv/Scripts/python.exe"));
        candidates.push(PathBuf::from("../.venv/Scripts/python.exe"));
        candidates.push(PathBuf::from(".venv/Scripts/python.exe"));
    }
    #[cfg(not(windows))]
    {
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.venv/bin/python"));
        candidates.push(PathBuf::from("../.venv/bin/python"));
        candidates.push(PathBuf::from(".venv/bin/python"));
        candidates.push(PathBuf::from("/Users/nemo/.gemini/antigravity/scratch/podcraft-studio/.venv/bin/python"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/python3"));
        candidates.push(PathBuf::from("/usr/local/bin/python3"));
        candidates.push(PathBuf::from("/usr/bin/python3"));
    }

    for c in candidates {
        if c.exists() {
            return c.to_string_lossy().to_string();
        }
    }
    #[cfg(windows)]
    {
        "python".to_string()
    }
    #[cfg(not(windows))]
    {
        "python3".to_string()
    }
}

fn find_sidecar_script(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(res_dir) = app.path().resource_dir() {
        candidates.push(res_dir.join("sidecar/podcraft_ai.py"));
        candidates.push(res_dir.join("_up_/sidecar/podcraft_ai.py"));
        candidates.push(res_dir.join("podcraft_ai.py"));
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("sidecar/podcraft_ai.py"));
            candidates.push(exe_dir.join("_up_/sidecar/podcraft_ai.py"));
            candidates.push(exe_dir.join("../Resources/sidecar/podcraft_ai.py"));
            candidates.push(exe_dir.join("../Resources/_up_/sidecar/podcraft_ai.py"));
            candidates.push(exe_dir.join("../Resources/podcraft_ai.py"));
        }
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecar/podcraft_ai.py"));
    candidates.push(PathBuf::from("../sidecar/podcraft_ai.py"));
    candidates.push(PathBuf::from("sidecar/podcraft_ai.py"));
    candidates.push(PathBuf::from("/Users/nemo/.gemini/antigravity/scratch/podcraft-studio/sidecar/podcraft_ai.py"));
    if let Some(home) = get_user_home_dir() {
        candidates.push(home.join(".tapwave/sidecar/podcraft_ai.py"));
    }

    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| "未找到 sidecar/podcraft_ai.py 脚本".to_string())
}

fn find_models_dir(app: &AppHandle) -> PathBuf {
    if let Ok(guard) = get_custom_models_dir_lock().read() {
        if let Some(ref p) = *guard {
            if p.exists() {
                return p.clone();
            }
        }
    }
    if let Ok(custom) = std::env::var("TAPWAVE_MODELS_DIR") {
        let p = PathBuf::from(custom);
        if p.exists() {
            return p;
        }
    }
    let mut candidates = Vec::new();
    if let Some(home_p) = get_user_home_dir() {
        candidates.push(home_p.join(".tapwave/models"));
        candidates.push(home_p.join("Library/Application Support/com.tapwave.studio/models"));
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../models"));
    candidates.push(PathBuf::from("../models"));
    candidates.push(PathBuf::from("models"));
    candidates.push(PathBuf::from("/Users/nemo/.gemini/antigravity/scratch/podcraft-studio/models"));
    if let Ok(res_dir) = app.path().resource_dir() {
        candidates.push(res_dir.join("models"));
    }
    for c in &candidates {
        if c.exists() && c.join("silero_vad.onnx").exists() {
            return c.clone();
        }
    }
    if let Some(home) = get_user_home_dir() {
        home.join(".tapwave/models")
    } else {
        PathBuf::from("models")
    }
}

fn percent_decode_path(encoded: &str) -> String {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Ok(hex_str), true) = (std::str::from_utf8(&bytes[i + 1..i + 3]), true) {
                if let Ok(val) = u8::from_str_radix(hex_str, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[tauri::command]
async fn inspect_and_align_tracks(
    app: AppHandle,
    req: InspectProjectRequest,
) -> Result<Vec<TrackInspectionResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inspect_and_align_project_with_progress(&req, |p: ImportProgressPayload| {
            let base_pct = ((p.completed as f64 / (p.total.max(1) as f64)) * 45.0).round() as u8;
            let _ = app.emit(
                "load-progress",
                UiLoadProgressEvent {
                    percent: base_pct.clamp(3, 48),
                    stage: p.stage,
                    message: p.message,
                },
            );
        })
    })
    .await
    .map_err(|e| format!("后台导入任务异常: {}", e))?
}

#[tauri::command]
async fn render_podcast_export(
    app: AppHandle,
    req: RenderMixRequest,
) -> Result<RenderMixResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = app.emit(
            "load-progress",
            UiLoadProgressEvent {
                percent: 25,
                stage: "export_mix".into(),
                message: "正在多轨合并合成、应用门限防串音与全局二次音量标准化 (-16.0 LUFS)...".into(),
            },
        );
        let res = render_master_podcast_mix(&req)?;
        let _ = app.emit(
            "load-progress",
            UiLoadProgressEvent {
                percent: 100,
                stage: "done".into(),
                message: "成片导出完成，已完成合并与二次音量标准化 (-16.0 LUFS)".into(),
            },
        );
        Ok(res)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_daw_project(req: ExportReaperRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || export_reaper_rpp(&req))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_wechat_video_mp4(req: MuxWeChatVideoRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || mux_wechat_mp4(&req))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_project_file(file_path: String, content_json: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = Path::new(&file_path).parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&file_path, content_json.as_bytes())
            .map_err(|e| format!("保存工程文件失败 ({}): {}", file_path, e))?;
        Ok(file_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_binary_file(file_path: String, bytes: Vec<u8>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = Path::new(&file_path).parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&file_path, &bytes)
            .map_err(|e| format!("保存文件失败 ({}): {}", file_path, e))?;
        Ok(file_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_project_file(app: AppHandle, file_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = app.emit(
            "load-progress",
            UiLoadProgressEvent {
                percent: 20,
                stage: "project_read".into(),
                message: format!("正在读取工程文件: {} ...", file_path),
            },
        );
        let content = fs::read_to_string(&file_path)
            .map_err(|e| format!("无法读取工程文件 ({}): {}", file_path, e))?;
        let _ = app.emit(
            "load-progress",
            UiLoadProgressEvent {
                percent: 85,
                stage: "project_parse".into(),
                message: "正在校验多轨路径并恢复文稿与剪辑切片状态...".into(),
            },
        );
        Ok(content)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_subtitle_bytes(file_path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::read(&file_path).map_err(|e| format!("无法读取字幕文件 ({}): {}", file_path, e))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn cancel_ai_sidecar() -> Result<bool, String> {
    if let Ok(mut guard) = get_sidecar_child_pid_lock().lock() {
        if let Some(pid) = guard.take() {
            #[cfg(unix)]
            {
                let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output();
            }
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command]
async fn run_ai_sidecar(app: AppHandle, payload_json: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script = find_sidecar_script(&app)?;
        let py_bin = find_python_bin();
        let models_dir = find_models_dir(&app);

        let mut child = Command::new(&py_bin)
            .env("TAPWAVE_MODELS_DIR", &models_dir)
            .arg("-u")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动 AI 识别服务失败 ({}): {}", py_bin, e))?;

        let child_id = child.id();
        if let Ok(mut guard) = get_sidecar_child_pid_lock().lock() {
            *guard = Some(child_id);
        }

        struct CleanPidOnDrop;
        impl Drop for CleanPidOnDrop {
            fn drop(&mut self) {
                if let Ok(mut guard) = get_sidecar_child_pid_lock().lock() {
                    *guard = None;
                }
            }
        }
        let _cleaner = CleanPidOnDrop;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(payload_json.as_bytes())
                .map_err(|e| e.to_string())?;
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法读取 AI 服务输出流".to_string())?;
        let reader = BufReader::new(stdout);
        let mut final_json = String::new();

        for line_res in reader.lines() {
            let line = line_res.map_err(|e| e.to_string())?;
            let trimmed = line.trim();
            if let Some(prog_str) = trimmed.strip_prefix("PROGRESS:") {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(prog_str) {
                    let pct = val.get("pct").and_then(|v| v.as_u64()).unwrap_or(65) as u8;
                    let msg = val
                        .get("msg")
                        .and_then(|v| v.as_str())
                        .unwrap_or("正在执行语音转写与语义分析...")
                        .to_string();
                    let _ = app.emit(
                        "load-progress",
                        UiLoadProgressEvent {
                            percent: pct,
                            stage: "asr_ai".into(),
                            message: msg,
                        },
                    );
                }
            } else if !trimmed.is_empty() {
                final_json = trimmed.to_string();
            }
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() && final_json.is_empty() {
            return Err("Python AI Sidecar 执行异常退出".into());
        }
        if final_json.is_empty() {
            return Err("AI Sidecar 未返回有效 JSON 数据".into());
        }
        Ok(final_json)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_dependencies_status(app: AppHandle) -> Result<DependenciesStatusDto, String> {
    let py_bin = find_python_bin();
    let has_python = Command::new(&py_bin).arg("--version").output().is_ok();
    let script_res = find_sidecar_script(&app);
    let has_sidecar = script_res.is_ok();
    let sidecar_path = script_res.ok().map(|p| p.to_string_lossy().to_string());
    let models_dir = find_models_dir(&app);
    let sense_voice_dir = models_dir.join("sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17");
    let has_sense_voice = sense_voice_dir.join("model.int8.onnx").exists()
        && sense_voice_dir.join("tokens.txt").exists();
    let has_silero_vad = models_dir.join("silero_vad.onnx").exists();
    let has_paraformer = models_dir
        .join("sherpa-onnx-paraformer-zh-small-2024-03-09")
        .join("model.int8.onnx")
        .exists();

    let models_ready = (has_sense_voice || has_paraformer) && has_silero_vad;
    let mut missing_models = Vec::new();
    if !has_sense_voice && !has_paraformer {
        missing_models.push("SenseVoiceSmall 离线语音识别模型 (约 230MB)".into());
    }
    if !has_silero_vad {
        missing_models.push("Silero VAD 语音断句模型 (约 640KB)".into());
    }

    let recommended_mode = if models_ready {
        "local_sensevoice".into()
    } else {
        "volcengine_doubao".into()
    };

    Ok(DependenciesStatusDto {
        has_python,
        python_bin: py_bin,
        has_sidecar,
        sidecar_path,
        models_dir: models_dir.to_string_lossy().to_string(),
        has_sense_voice,
        has_silero_vad,
        has_paraformer,
        models_ready,
        missing_models,
        recommended_mode,
    })
}

#[tauri::command]
async fn set_custom_models_dir(app: AppHandle, path: String) -> Result<DependenciesStatusDto, String> {
    let p = PathBuf::from(path.trim());
    if !p.exists() {
        return Err("指定的模型目录不存在，请选择有效文件夹".into());
    }
    if let Ok(mut guard) = get_custom_models_dir_lock().write() {
        *guard = Some(p);
    }
    get_dependencies_status(app).await
}

#[tauri::command]
async fn start_download_local_models(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let emit_prog = |pct: u8, stage: &str, msg: &str, is_done: bool, err: Option<String>| {
            let _ = app.emit(
                "model-download-progress",
                ModelDownloadProgressPayload {
                    percent: pct,
                    stage: stage.to_string(),
                    message: msg.to_string(),
                    is_done,
                    error: err,
                },
            );
        };

        emit_prog(5, "prepare", "准备模型存放目录...", false, None);

        let target_dir = if let Some(home) = get_user_home_dir() {
            home.join(".tapwave/models")
        } else {
            PathBuf::from("models")
        };

        if let Err(e) = std::fs::create_dir_all(&target_dir) {
            let err_msg = format!("无法创建模型目录: {}", e);
            emit_prog(0, "error", &err_msg, false, Some(err_msg.clone()));
            return Err(err_msg);
        }

        // 检查本地开发目录或其他位置是否已有现成模型，若有则快速就地同步（秒级拷贝）
        let local_candidates = [
            PathBuf::from("/Users/nemo/.gemini/antigravity/scratch/podcraft-studio/models"),
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../models"),
        ];

        for cand in &local_candidates {
            if cand.exists() && cand.join("silero_vad.onnx").exists() {
                emit_prog(20, "sync_local", "发现本地开发环境已缓存模型，正在快速部署...", false, None);
                let _ = Command::new("cp")
                    .arg("-R")
                    .arg(format!("{}/.", cand.to_string_lossy()))
                    .arg(format!("{}/", target_dir.to_string_lossy()))
                    .output();
                if target_dir.join("silero_vad.onnx").exists() {
                    emit_prog(100, "completed", "本地离线语音模型已成功就绪！", true, None);
                    return Ok("已快速就地同步就绪".into());
                }
            }
        }

        emit_prog(15, "download_vad", "正在下载 Silero VAD 语音断句模型 (约 640KB)...", false, None);
        let vad_dest = target_dir.join("silero_vad.onnx");
        let vad_urls = [
            "https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
        ];
        let mut vad_ok = false;
        for u in &vad_urls {
            let res = Command::new("curl")
                .arg("-fSL")
                .arg("--connect-timeout")
                .arg("10")
                .arg("-o")
                .arg(&vad_dest)
                .arg(u)
                .output();
            if res.is_ok() && vad_dest.exists() && std::fs::metadata(&vad_dest).map(|m| m.len() > 100_000).unwrap_or(false) {
                vad_ok = true;
                break;
            }
        }
        if !vad_ok {
            let err_msg = "下载 Silero VAD 模型失败，请检查网络连接或选择云端识别模式".to_string();
            emit_prog(0, "error", &err_msg, false, Some(err_msg.clone()));
            return Err(err_msg);
        }

        emit_prog(35, "download_sensevoice", "正在下载 SenseVoice 神经网络模型包 (约 230MB)...", false, None);
        let tar_dest = target_dir.join("sense_voice.tar.bz2");
        let asr_urls = [
            "https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
        ];
        let mut asr_ok = false;
        for u in &asr_urls {
            emit_prog(50, "download_sensevoice", "下载进行中 (约需 1~3 分钟，视网络速度)...", false, None);
            let res = Command::new("curl")
                .arg("-fSL")
                .arg("--connect-timeout")
                .arg("15")
                .arg("-o")
                .arg(&tar_dest)
                .arg(u)
                .output();
            if res.is_ok() && tar_dest.exists() && std::fs::metadata(&tar_dest).map(|m| m.len() > 10_000_000).unwrap_or(false) {
                asr_ok = true;
                break;
            }
        }
        if !asr_ok {
            let err_msg = "下载 SenseVoice 模型包超时或失败，推荐您切换为无需下载的云端豆包/DeepSeek大模型识别".to_string();
            emit_prog(0, "error", &err_msg, false, Some(err_msg.clone()));
            return Err(err_msg);
        }

        emit_prog(85, "extract", "正在解压模型文件到 ~/.tapwave/models...", false, None);
        let _ = Command::new("tar")
            .arg("-xjf")
            .arg(&tar_dest)
            .arg("-C")
            .arg(&target_dir)
            .output();

        let _ = std::fs::remove_file(&tar_dest);

        let final_check = target_dir.join("sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/model.int8.onnx");
        if final_check.exists() {
            emit_prog(100, "completed", "本地离线语音模型安装完成，已全部就绪！", true, None);
            Ok("模型下载解压完成".into())
        } else {
            let err_msg = "模型解压校验失败，请重试或手动放置模型文件".to_string();
            emit_prog(0, "error", &err_msg, false, Some(err_msg.clone()));
            Err(err_msg)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn infer_audio_mime(file_path: &str) -> &'static str {
    let lower = file_path.to_ascii_lowercase();
    if lower.ends_with(".mp3") {
        "audio/mpeg"
    } else if lower.ends_with(".m4a") || lower.ends_with(".mp4") {
        "audio/mp4"
    } else if lower.ends_with(".aac") {
        "audio/aac"
    } else if lower.ends_with(".ogg") || lower.ends_with(".opus") {
        "audio/ogg"
    } else if lower.ends_with(".flac") {
        "audio/flac"
    } else {
        "audio/wav"
    }
}

pub(crate) fn needs_wav_transcode(file_path: &str) -> bool {
    let lower = file_path.to_ascii_lowercase();
    lower.ends_with(".flac")
        || lower.ends_with(".ogg")
        || lower.ends_with(".opus")
        || lower.ends_with(".wma")
}

pub(crate) fn transcode_to_cached_proxy_wav(input_path: &str) -> Result<String, String> {
    let meta = fs::metadata(input_path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut hasher = DefaultHasher::new();
    input_path.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    mtime.hash(&mut hasher);
    let cache_dir = PathBuf::from("/tmp/podcraft_playback_cache");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let out_wav = cache_dir.join(format!("px_{:016x}.wav", hasher.finish()));
    let out_str = out_wav.to_string_lossy().to_string();

    if out_wav.exists() && fs::metadata(&out_wav).map(|m| m.len() > 44).unwrap_or(false) {
        return Ok(out_str);
    }

    let tmp_wav = cache_dir.join(format!("px_{:016x}_{}.tmp.wav", hasher.finish(), std::process::id()));
    let tmp_str = tmp_wav.to_string_lossy().to_string();

    let status = Command::new(find_ffmpeg_bin())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .args([
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-threads",
            "0",
            "-i",
            input_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-sample_fmt",
            "s16",
            &tmp_str,
        ])
        .status()
        .map_err(|e| e.to_string())?;

    if !status.success() {
        let _ = fs::remove_file(&tmp_wav);
        return Err("FFmpeg 代理音频转码失败".into());
    }
    let _ = fs::rename(&tmp_wav, &out_wav);
    Ok(out_str)
}

fn read_proxy_wav_chunk(proxy_wav_path: &str, chunk_idx: u64) -> Result<Vec<u8>, String> {
    let mut f = File::open(proxy_wav_path).map_err(|e| e.to_string())?;
    let total_len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if total_len <= 44 {
        return Err("Invalid proxy WAV".into());
    }
    let mut hdr_probe = [0u8; 256];
    let probe_len = f.read(&mut hdr_probe).unwrap_or(0);
    let mut data_offset = 44u64;
    if probe_len >= 44 {
        for i in 12..probe_len.saturating_sub(8) {
            if &hdr_probe[i..i + 4] == b"data" {
                data_offset = (i + 8) as u64;
                break;
            }
        }
    }
    let bytes_per_sec: u64 = 16000 * 2;
    let start_byte = data_offset + chunk_idx * 30 * bytes_per_sec;
    if start_byte >= total_len {
        return Err("Chunk past EOF".into());
    }
    let want_bytes = 32 * bytes_per_sec;
    let avail = (total_len - start_byte).min(want_bytes) as usize;
    f.seek(SeekFrom::Start(start_byte)).map_err(|e| e.to_string())?;
    let mut pcm = vec![0u8; avail];
    f.read_exact(&mut pcm).map_err(|e| e.to_string())?;

    let data_size = avail as u32;
    let riff_size = 36u32.saturating_add(data_size);
    let mut out = Vec::with_capacity(44 + avail);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_size.to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes());  // AudioFormat = 1
    out.extend_from_slice(&1u16.to_le_bytes());  // NumChannels = 1
    out.extend_from_slice(&16000u32.to_le_bytes()); // SampleRate
    out.extend_from_slice(&(16000u32 * 2).to_le_bytes()); // ByteRate
    out.extend_from_slice(&2u16.to_le_bytes());  // BlockAlign
    out.extend_from_slice(&16u16.to_le_bytes()); // BitsPerSample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_size.to_le_bytes());
    out.extend_from_slice(&pcm);
    Ok(out)
}

pub(crate) fn transcode_to_cached_wav(input_path: &str) -> Result<String, String> {
    let meta = fs::metadata(input_path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut hasher = DefaultHasher::new();
    input_path.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    mtime.hash(&mut hasher);
    let cache_dir = PathBuf::from("/tmp/podcraft_playback_cache");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let out_wav = cache_dir.join(format!("pb_{:016x}.wav", hasher.finish()));
    let out_str = out_wav.to_string_lossy().to_string();

    if out_wav.exists() && fs::metadata(&out_wav).map(|m| m.len() > 44).unwrap_or(false) {
        return Ok(out_str);
    }

    let tmp_wav = cache_dir.join(format!("pb_{:016x}_{}.tmp.wav", hasher.finish(), std::process::id()));
    let tmp_str = tmp_wav.to_string_lossy().to_string();

    let status = Command::new(find_ffmpeg_bin())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .args([
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-threads",
            "0",
            "-i",
            input_path,
            "-vn",
            "-ar",
            "48000",
            "-sample_fmt",
            "s16",
            &tmp_str,
        ])
        .status()
        .map_err(|e| e.to_string())?;

    if !status.success() {
        let _ = fs::remove_file(&tmp_wav);
        return Err("FFmpeg 预览转码失败".into());
    }
    let _ = fs::rename(&tmp_wav, &out_wav);
    Ok(out_str)
}

fn get_or_build_waveform_envelope_bin(file_path: &str) -> Result<PathBuf, String> {
    let meta = fs::metadata(file_path)
        .map_err(|e| format!("无法访问音频文件 ({}): {}", file_path, e))?;
    if !meta.is_file() {
        return Err(format!("音频路径不是有效文件: {}", file_path));
    }
    let mtime_nanos = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let mut hasher = DefaultHasher::new();
    file_path.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    mtime_nanos.hash(&mut hasher);
    let h = hasher.finish();

    let cache_dir = PathBuf::from("/tmp/podcraft_playback_cache");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let out_bin = cache_dir.join(format!("wenv_v1_{:016x}.bin", h));
    if out_bin.exists() && fs::metadata(&out_bin).map(|m| m.len() >= 22).unwrap_or(false) {
        return Ok(out_bin);
    }

    let mut child = Command::new(find_ffmpeg_bin())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .args([
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
        ])
        .spawn()
        .map_err(|e| format!("无法启动 ffmpeg 提取波形包络 {}: {}", file_path, e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 ffmpeg 波形包络输出流".to_string())?;
    let mut reader = BufReader::with_capacity(65_536, stdout);

    const BIN_SAMPLES: usize = 80; // 5ms at 16,000 Hz
    let mut triples: Vec<[u16; 3]> = Vec::new();
    let mut pos_max = 0.0_f32;
    let mut neg_max = 0.0_f32;
    let mut sum_sq = 0.0_f64;
    let mut cnt = 0usize;

    let mut read_buf = [0u8; 32_768];
    let mut leftover_byte: Option<u8> = None;

    loop {
        let n = reader.read(&mut read_buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let mut slice = &read_buf[..n];
        if let Some(prev_b) = leftover_byte.take() {
            let s = i16::from_le_bytes([prev_b, slice[0]]) as f32 / 32768.0;
            if s > pos_max {
                pos_max = s;
            }
            if -s > neg_max {
                neg_max = -s;
            }
            sum_sq += (s as f64) * (s as f64);
            cnt += 1;
            if cnt >= BIN_SAMPLES {
                let rms = (sum_sq / (cnt as f64)).sqrt() as f32;
                triples.push([
                    (pos_max.clamp(0.0, 1.0) * 65535.0).round() as u16,
                    (neg_max.clamp(0.0, 1.0) * 65535.0).round() as u16,
                    (rms.clamp(0.0, 1.0) * 65535.0).round() as u16,
                ]);
                pos_max = 0.0;
                neg_max = 0.0;
                sum_sq = 0.0;
                cnt = 0;
            }
            slice = &slice[1..];
        }
        if slice.len() % 2 == 1 {
            leftover_byte = Some(slice[slice.len() - 1]);
            slice = &slice[..slice.len() - 1];
        }
        for pair in slice.chunks_exact(2) {
            let s = i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0;
            if s > pos_max {
                pos_max = s;
            }
            if -s > neg_max {
                neg_max = -s;
            }
            sum_sq += (s as f64) * (s as f64);
            cnt += 1;
            if cnt >= BIN_SAMPLES {
                let rms = (sum_sq / (cnt as f64)).sqrt() as f32;
                triples.push([
                    (pos_max.clamp(0.0, 1.0) * 65535.0).round() as u16,
                    (neg_max.clamp(0.0, 1.0) * 65535.0).round() as u16,
                    (rms.clamp(0.0, 1.0) * 65535.0).round() as u16,
                ]);
                pos_max = 0.0;
                neg_max = 0.0;
                sum_sq = 0.0;
                cnt = 0;
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if cnt > 0 {
        let rms = (sum_sq / (cnt as f64)).sqrt() as f32;
        triples.push([
            (pos_max.clamp(0.0, 1.0) * 65535.0).round() as u16,
            (neg_max.clamp(0.0, 1.0) * 65535.0).round() as u16,
            (rms.clamp(0.0, 1.0) * 65535.0).round() as u16,
        ]);
    }
    if !status.success() && triples.is_empty() {
        return Err(format!("ffmpeg 提取波形包络失败: {}", file_path));
    }

    let num_bins = triples.len() as u32;
    let mut out_bytes = Vec::with_capacity(16 + triples.len() * 6);
    out_bytes.extend_from_slice(b"WENV");
    out_bytes.extend_from_slice(&1u32.to_le_bytes());
    out_bytes.extend_from_slice(&5u32.to_le_bytes());
    out_bytes.extend_from_slice(&num_bins.to_le_bytes());
    for [pos_u16, neg_u16, rms_u16] in triples {
        out_bytes.extend_from_slice(&pos_u16.to_le_bytes());
        out_bytes.extend_from_slice(&neg_u16.to_le_bytes());
        out_bytes.extend_from_slice(&rms_u16.to_le_bytes());
    }

    let unique_ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_bin = cache_dir.join(format!(
        "wenv_v1_{:016x}_{}_{}.tmp",
        h,
        std::process::id(),
        unique_ns
    ));
    fs::write(&tmp_bin, &out_bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp_bin, &out_bin).map_err(|e| e.to_string())?;
    Ok(out_bin)
}

fn copy_buffered(src: &mut dyn Read, dst: &mut TcpStream) {
    let mut buf = vec![0u8; 131_072];
    loop {
        match src.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if dst.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
        }
    }
}

fn parse_byte_range(range_val: &str, total_len: u64) -> Option<(u64, u64)> {
    let spec = range_val.strip_prefix("bytes=")?;
    let first_range = spec.split(',').next().unwrap_or(spec);
    let mut rparts = first_range.split('-');
    let start_opt = rparts.next().unwrap_or("").trim();
    let end_opt = rparts.next().unwrap_or("").trim();

    let (start, end) = if start_opt.is_empty() {
        let suffix: u64 = end_opt.parse().ok()?;
        let s = total_len.saturating_sub(suffix);
        (s, total_len.saturating_sub(1))
    } else {
        let s: u64 = start_opt.parse().ok()?;
        let e: u64 = if end_opt.is_empty() {
            total_len.saturating_sub(1)
        } else {
            end_opt.parse::<u64>().ok()?.min(total_len.saturating_sub(1))
        };
        (s, e)
    };
    Some((start, end))
}

fn send_json_response(stream: &mut TcpStream, status: &str, body: &str) {
    let hdr = format!(
        "HTTP/1.1 {}\r\n\
        Content-Type: application/json; charset=utf-8\r\n\
        Content-Length: {}\r\n\
        Access-Control-Allow-Origin: *\r\n\
        Cache-Control: no-cache\r\n\
        Connection: close\r\n\r\n",
        status,
        body.len()
    );
    let _ = stream.write_all(hdr.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn handle_audio_http_client(mut stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
    let cloned = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut reader = BufReader::new(cloned);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let raw_target = parts.next().unwrap_or("");

    let mut range_header: Option<String> = None;
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            let k_trim = k.trim();
            if k_trim.eq_ignore_ascii_case("range") {
                range_header = Some(v.trim().to_string());
            } else if k_trim.eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse::<usize>().unwrap_or(0);
            }
        }
    }

    if method.eq_ignore_ascii_case("OPTIONS") {
        let hdr = "HTTP/1.1 204 No Content\r\n\
            Access-Control-Allow-Origin: *\r\n\
            Access-Control-Allow-Methods: GET, HEAD, POST, OPTIONS\r\n\
            Access-Control-Allow-Headers: Range, Content-Type, Accept\r\n\
            Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n\
            Connection: close\r\n\r\n";
        let _ = stream.write_all(hdr.as_bytes());
        return;
    }

    let (route_path, query_str) = raw_target.split_once('?').unwrap_or((raw_target, ""));

    // Virtual Multi-Track Real-Time Mix Configuration Endpoint (POST /audio-mix-config)
    if method.eq_ignore_ascii_case("POST") && route_path == "/audio-mix-config" {
        if content_length == 0 || content_length > 64 * 1024 * 1024 {
            send_json_response(
                &mut stream,
                "400 Bad Request",
                "{\"ok\":false,\"error\":\"Invalid Content-Length\"}",
            );
            return;
        }
        let mut body_buf = vec![0u8; content_length];
        if reader.read_exact(&mut body_buf).is_err() {
            send_json_response(
                &mut stream,
                "400 Bad Request",
                "{\"ok\":false,\"error\":\"Failed to read request body\"}",
            );
            return;
        }
        let spec: LiveMixSpec = match serde_json::from_slice(&body_buf) {
            Ok(s) => s,
            Err(e) => {
                let err_msg = e.to_string().replace('"', "'");
                send_json_response(
                    &mut stream,
                    "400 Bad Request",
                    &format!("{{\"ok\":false,\"error\":\"{}\"}}", err_msg),
                );
                return;
            }
        };
        match register_live_mix(spec) {
            Ok(prepared) => {
                let dur_sec = (prepared.total_frames as f64) / (MIX_SAMPLE_RATE as f64);
                let resp_json = format!(
                    "{{\"ok\":true,\"rev\":{},\"totalFrames\":{},\"durationSec\":{:.4}}}",
                    prepared.rev, prepared.total_frames, dur_sec
                );
                send_json_response(&mut stream, "200 OK", &resp_json);
            }
            Err(e) => {
                let err_msg = e.replace('"', "'");
                send_json_response(
                    &mut stream,
                    "500 Internal Server Error",
                    &format!("{{\"ok\":false,\"error\":\"{}\"}}", err_msg),
                );
            }
        }
        return;
    }

    if !method.eq_ignore_ascii_case("GET") && !method.eq_ignore_ascii_case("HEAD") {
        let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
        return;
    }
    let is_head = method.eq_ignore_ascii_case("HEAD");

    // Sample-Accurate Virtual Unified Mix Stream Endpoint (GET/HEAD /audio-mix?rev=<rev>)
    if route_path == "/audio-mix" {
        let mut requested_rev: Option<u64> = None;
        for pair in query_str.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == "rev" {
                    requested_rev = v.parse::<u64>().ok();
                }
            }
        }
        let Some(mix) = get_live_mix(requested_rev) else {
            let hdr = "HTTP/1.1 404 Not Found\r\n\
                Access-Control-Allow-Origin: *\r\n\
                Content-Length: 0\r\n\
                Connection: close\r\n\r\n";
            let _ = stream.write_all(hdr.as_bytes());
            return;
        };

        let total_len = mix.total_wav_len;
        if let Some(ref range_val) = range_header {
            if total_len > 0 {
                if let Some((start, end)) = parse_byte_range(range_val, total_len) {
                    if start >= total_len || start > end {
                        let hdr = format!(
                            "HTTP/1.1 416 Range Not Satisfiable\r\n\
                            Access-Control-Allow-Origin: *\r\n\
                            Content-Range: bytes */{}\r\n\
                            Connection: close\r\n\r\n",
                            total_len
                        );
                        let _ = stream.write_all(hdr.as_bytes());
                        return;
                    }
                    let chunk_len = end - start + 1;
                    let hdr = format!(
                        "HTTP/1.1 206 Partial Content\r\n\
                        Content-Type: audio/wav\r\n\
                        Accept-Ranges: bytes\r\n\
                        Content-Range: bytes {}-{}/{}\r\n\
                        Content-Length: {}\r\n\
                        Access-Control-Allow-Origin: *\r\n\
                        Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n\
                        Cache-Control: public, max-age=3600\r\n\
                        Connection: close\r\n\r\n",
                        start, end, total_len, chunk_len
                    );
                    if stream.write_all(hdr.as_bytes()).is_ok() {
                        stream_live_mix_range(&mut stream, &mix, start, end, is_head);
                    }
                    return;
                }
            }
        }

        let hdr = format!(
            "HTTP/1.1 200 OK\r\n\
            Content-Type: audio/wav\r\n\
            Accept-Ranges: bytes\r\n\
            Content-Length: {}\r\n\
            Access-Control-Allow-Origin: *\r\n\
            Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n\
            Cache-Control: public, max-age=3600\r\n\
            Connection: close\r\n\r\n",
            total_len
        );
        if stream.write_all(hdr.as_bytes()).is_ok() && total_len > 0 {
            stream_live_mix_range(&mut stream, &mix, 0, total_len - 1, is_head);
        }
        return;
    }

    // High-Resolution 5ms (200Hz) Bipolar + RMS Binary Waveform Envelope Endpoint
    if route_path == "/waveform-envelope" {
        let mut decoded_path = String::new();
        for pair in query_str.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == "path" {
                    decoded_path = percent_decode_path(v);
                }
            }
        }
        if decoded_path.is_empty() || !Path::new(&decoded_path).exists() {
            let hdr = "HTTP/1.1 404 Not Found\r\n\
                Access-Control-Allow-Origin: *\r\n\
                Content-Length: 0\r\n\
                Connection: close\r\n\r\n";
            let _ = stream.write_all(hdr.as_bytes());
            return;
        }
        match get_or_build_waveform_envelope_bin(&decoded_path) {
            Ok(bin_path) => match File::open(&bin_path) {
                Ok(mut f) => {
                    let total_len = f.metadata().map(|m| m.len()).unwrap_or(0);
                    let hdr = format!(
                        "HTTP/1.1 200 OK\r\n\
                        Content-Type: application/octet-stream\r\n\
                        Content-Length: {}\r\n\
                        Access-Control-Allow-Origin: *\r\n\
                        Cache-Control: public, max-age=3600\r\n\
                        Connection: close\r\n\r\n",
                        total_len
                    );
                    if stream.write_all(hdr.as_bytes()).is_ok() && !is_head && total_len > 0 {
                        copy_buffered(&mut f, &mut stream);
                    }
                }
                Err(_) => {
                    let hdr = "HTTP/1.1 404 Not Found\r\n\
                        Access-Control-Allow-Origin: *\r\n\
                        Content-Length: 0\r\n\
                        Connection: close\r\n\r\n";
                    let _ = stream.write_all(hdr.as_bytes());
                }
            },
            Err(err) => {
                let msg = err.replace('"', "'");
                send_json_response(
                    &mut stream,
                    "500 Internal Server Error",
                    &format!("{{\"ok\":false,\"error\":\"{}\"}}", msg),
                );
            }
        }
        return;
    }

    // Extract ?path=...&transcode=...&proxy=...&chunk=... from query string (or legacy path segment)
    let mut decoded_path = String::new();
    let mut force_transcode_wav = false;
    let mut use_proxy = false;
    let mut proxy_chunk_idx: Option<u64> = None;
    for pair in query_str.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == "path" {
                decoded_path = percent_decode_path(v);
            } else if k == "transcode" && v == "wav" {
                force_transcode_wav = true;
            } else if k == "proxy" && (v == "1" || v == "true") {
                use_proxy = true;
            } else if k == "chunk" {
                if let Ok(idx) = v.parse::<u64>() {
                    proxy_chunk_idx = Some(idx);
                }
            }
        }
    }
    if decoded_path.is_empty() && route_path.len() > 1 {
        let fallback = route_path.strip_prefix("/audio/").or_else(|| route_path.strip_prefix('/'));
        if let Some(seg) = fallback {
            decoded_path = percent_decode_path(seg);
        }
    }

    if decoded_path.is_empty() || !Path::new(&decoded_path).exists() {
        let hdr = "HTTP/1.1 404 Not Found\r\n\
            Access-Control-Allow-Origin: *\r\n\
            Content-Length: 0\r\n\
            Connection: close\r\n\r\n";
        let _ = stream.write_all(hdr.as_bytes());
        return;
    }

    let serve_path = if use_proxy {
        transcode_to_cached_proxy_wav(&decoded_path).unwrap_or_else(|_| decoded_path.clone())
    } else if force_transcode_wav || needs_wav_transcode(&decoded_path) {
        transcode_to_cached_wav(&decoded_path).unwrap_or_else(|_| decoded_path.clone())
    } else {
        decoded_path
    };

    if use_proxy {
        if let Some(chunk_idx) = proxy_chunk_idx {
            if let Ok(chunk_bytes) = read_proxy_wav_chunk(&serve_path, chunk_idx) {
                let hdr = format!(
                    "HTTP/1.1 200 OK\r\n\
                    Access-Control-Allow-Origin: *\r\n\
                    Content-Type: audio/wav\r\n\
                    Content-Length: {}\r\n\
                    Cache-Control: public, max-age=3600\r\n\
                    Connection: close\r\n\r\n",
                    chunk_bytes.len()
                );
                let _ = stream.write_all(hdr.as_bytes());
                let _ = stream.write_all(&chunk_bytes);
                return;
            }
        }
    }

    let mut file = match File::open(&serve_path) {
        Ok(f) => f,
        Err(_) => {
            let hdr = "HTTP/1.1 404 Not Found\r\n\
                Access-Control-Allow-Origin: *\r\n\
                Content-Length: 0\r\n\
                Connection: close\r\n\r\n";
            let _ = stream.write_all(hdr.as_bytes());
            return;
        }
    };

    let total_len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mime = infer_audio_mime(&serve_path);

    if let Some(ref range_val) = range_header {
        if total_len > 0 {
            if let Some((start, end)) = parse_byte_range(range_val, total_len) {
                if start >= total_len || start > end {
                    let hdr = format!(
                        "HTTP/1.1 416 Range Not Satisfiable\r\n\
                        Access-Control-Allow-Origin: *\r\n\
                        Content-Range: bytes */{}\r\n\
                        Connection: close\r\n\r\n",
                        total_len
                    );
                    let _ = stream.write_all(hdr.as_bytes());
                    return;
                }

                let chunk_len = end - start + 1;
                if file.seek(SeekFrom::Start(start)).is_ok() {
                    let hdr = format!(
                        "HTTP/1.1 206 Partial Content\r\n\
                        Content-Type: {}\r\n\
                        Accept-Ranges: bytes\r\n\
                        Content-Range: bytes {}-{}/{}\r\n\
                        Content-Length: {}\r\n\
                        Access-Control-Allow-Origin: *\r\n\
                        Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n\
                        Cache-Control: public, max-age=3600\r\n\
                        Connection: close\r\n\r\n",
                        mime, start, end, total_len, chunk_len
                    );
                    if stream.write_all(hdr.as_bytes()).is_ok() && !is_head {
                        let mut limited = file.take(chunk_len);
                        copy_buffered(&mut limited, &mut stream);
                    }
                    return;
                }
            }
        }
    }

    let hdr = format!(
        "HTTP/1.1 200 OK\r\n\
        Content-Type: {}\r\n\
        Accept-Ranges: bytes\r\n\
        Content-Length: {}\r\n\
        Access-Control-Allow-Origin: *\r\n\
        Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n\
        Cache-Control: public, max-age=3600\r\n\
        Connection: close\r\n\r\n",
        mime, total_len
    );
    if stream.write_all(hdr.as_bytes()).is_ok() && !is_head && total_len > 0 {
        copy_buffered(&mut file, &mut stream);
    }
}

fn ensure_local_audio_http_server() -> u16 {
    *AUDIO_HTTP_PORT.get_or_init(|| {
        let listener = TcpListener::bind("127.0.0.1:19847")
            .or_else(|_| TcpListener::bind("127.0.0.1:0"))
            .expect("Failed to bind local PodCraft HTTP audio streaming server");
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                std::thread::spawn(move || {
                    handle_audio_http_client(conn);
                });
            }
        });
        port
    })
}

fn do_register_file_association() -> bool {
    #[cfg(target_os = "macos")]
    {
        let lsregister_candidates = [
            "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
            "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister",
        ];
        let mut target_app = "/Applications/点波 TapWave.app".to_string();
        if let Ok(exe_p) = std::env::current_exe() {
            if let Some(bundle) = exe_p.ancestors().find(|p| p.extension().and_then(|s| s.to_str()) == Some("app")) {
                target_app = bundle.to_string_lossy().to_string();
            }
        }

        for lsreg in &lsregister_candidates {
            if Path::new(lsreg).exists() {
                let _ = Command::new(lsreg)
                    .args(["-f", "-R", "-trusted", &target_app])
                    .output();
                return true;
            }
        }
    }
    false
}

#[tauri::command]
async fn get_pending_open_file() -> Result<Option<String>, String> {
    if let Ok(mut guard) = get_pending_open_file_lock().lock() {
        return Ok(guard.take());
    }
    Ok(None)
}

#[tauri::command]
async fn register_file_association() -> Result<bool, String> {
    Ok(do_register_file_association())
}

#[tauri::command]
fn get_audio_server_port() -> u16 {
    ensure_local_audio_http_server()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = ensure_local_audio_http_server();

    // 检查 CLI 启动参数是否有传入 .podcraft 工程文件
    for arg in std::env::args().skip(1) {
        if arg.ends_with(".podcraft") && Path::new(&arg).exists() {
            if let Ok(mut guard) = get_pending_open_file_lock().lock() {
                *guard = Some(arg);
            }
            break;
        }
    }

    // 自动刷新 macOS LaunchServices 文件关联注册
    do_register_file_association();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .register_uri_scheme_protocol("podaudio", |_ctx, request| {
            let uri_path = request.uri().path();
            let raw_path = percent_decode_path(uri_path.strip_prefix('/').unwrap_or(uri_path));
            let file_path = if raw_path.starts_with('/') {
                raw_path
            } else {
                format!("/{}", raw_path)
            };

            let mime = infer_audio_mime(&file_path);

            let mut file = match File::open(&file_path) {
                Ok(f) => f,
                Err(_) => {
                    return tauri::http::Response::builder()
                        .status(404)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Vec::new())
                        .unwrap();
                }
            };

            let total_len = file.metadata().map(|m| m.len()).unwrap_or(0);
            if total_len == 0 {
                return tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", mime)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(Vec::new())
                    .unwrap();
            }

            if let Some(range_hdr) = request
                .headers()
                .get("range")
                .and_then(|h| h.to_str().ok())
            {
                if let Some(byte_spec) = range_hdr.strip_prefix("bytes=") {
                    let mut parts = byte_spec.split('-');
                    let start: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                    let end: u64 = parts
                        .next()
                        .and_then(|s| if s.is_empty() { None } else { s.parse().ok() })
                        .unwrap_or(total_len - 1)
                        .min(total_len - 1);

                    if start <= end && file.seek(SeekFrom::Start(start)).is_ok() {
                        let read_len = (end - start + 1) as usize;
                        let mut buf = vec![0u8; read_len];
                        if file.read_exact(&mut buf).is_ok() {
                            return tauri::http::Response::builder()
                                .status(206)
                                .header("Content-Type", mime)
                                .header("Accept-Ranges", "bytes")
                                .header("Access-Control-Allow-Origin", "*")
                                .header(
                                    "Content-Range",
                                    format!("bytes {}-{}/{}", start, end, total_len),
                                )
                                .header("Content-Length", read_len.to_string())
                                .body(buf)
                                .unwrap();
                        }
                    }
                }
            }

            let mut full_buf = Vec::new();
            let _ = file.read_to_end(&mut full_buf);
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Accept-Ranges", "bytes")
                .header("Access-Control-Allow-Origin", "*")
                .header("Content-Length", full_buf.len().to_string())
                .body(full_buf)
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            get_audio_server_port,
            inspect_and_align_tracks,
            render_podcast_export,
            export_daw_project,
            export_wechat_video_mp4,
            save_project_file,
            save_binary_file,
            load_project_file,
            read_subtitle_bytes,
            run_ai_sidecar,
            cancel_ai_sidecar,
            get_dependencies_status,
            start_download_local_models,
            set_custom_models_dir,
            get_pending_open_file,
            register_file_association,
        ])
        .build(tauri::generate_context!())
        .expect("error while building PodCraft Studio Tauri application");

    app.run(|app_handle, event| {
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        if let tauri::RunEvent::Opened { urls } = &event {
            for url in urls {
                if let Ok(file_path) = url.to_file_path() {
                    let path_str = file_path.to_string_lossy().to_string();
                    if path_str.ends_with(".podcraft") {
                        if let Ok(mut guard) = get_pending_open_file_lock().lock() {
                            *guard = Some(path_str.clone());
                        }
                        let _ = app_handle.emit("open-file", &path_str);
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_audio_http_server_byte_ranges() {
        let tmp_path = "/tmp/podcraft_rust_http_test.wav";
        let mut fake_wav = b"RIFF____WAVEfmt ".to_vec();
        fake_wav.extend_from_slice(&[0u8; 100]);
        fs::write(tmp_path, &fake_wav).unwrap();

        let port = ensure_local_audio_http_server();
        assert!(port > 0);

        // 1. Test AVFoundation 2-byte Range probe (bytes=0-1)
        let mut conn = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let req = format!(
            "GET /audio?path=%2Ftmp%2Fpodcraft_rust_http_test.wav HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-1\r\n\r\n"
        );
        conn.write_all(req.as_bytes()).unwrap();
        let mut raw_resp = Vec::new();
        conn.read_to_end(&mut raw_resp).unwrap();
        let resp_str = String::from_utf8_lossy(&raw_resp);
        assert!(resp_str.starts_with("HTTP/1.1 206 Partial Content"));
        assert!(resp_str.contains(&format!("Content-Range: bytes 0-1/{}", fake_wav.len())));
        assert!(raw_resp.ends_with(b"\r\n\r\nRI"));
    }

    fn write_test_wav_with_list_metadata(path: &str, samples: &[i16]) {
        // Simulates Zoom P4next / FFmpeg Lavf WAV header with LIST chunk before data chunk
        let list_payload = b"INFOISFTLavf59.27.100\0"; // 22 bytes (even)
        let data_bytes = (samples.len() * 2) as u32;
        let riff_size = 4 + (8 + 16) + (8 + list_payload.len() as u32) + (8 + data_bytes);
        let mut buf = Vec::with_capacity((riff_size + 8) as usize);
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&riff_size.to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
        buf.extend_from_slice(&1u16.to_le_bytes()); // mono
        buf.extend_from_slice(&48000u32.to_le_bytes());
        buf.extend_from_slice(&(48000u32 * 2).to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes());
        buf.extend_from_slice(&16u16.to_le_bytes());
        buf.extend_from_slice(b"LIST");
        buf.extend_from_slice(&(list_payload.len() as u32).to_le_bytes());
        buf.extend_from_slice(list_payload);
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_bytes.to_le_bytes());
        for &s in samples {
            buf.extend_from_slice(&s.to_le_bytes());
        }
        fs::write(path, &buf).unwrap();
    }

    fn http_get_range(port: u16, target: &str, range: &str) -> (String, Vec<u8>) {
        let mut conn = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let req = format!(
            "GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: {}\r\n\r\n",
            target, range
        );
        conn.write_all(req.as_bytes()).unwrap();
        let mut raw = Vec::new();
        conn.read_to_end(&mut raw).unwrap();
        let split_pos = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let hdr = String::from_utf8_lossy(&raw[..split_pos]).to_string();
        let body = raw[split_pos + 4..].to_vec();
        (hdr, body)
    }

    #[test]
    fn test_virtual_audio_mix_wav_byte_range_streaming() {
        let p1 = "/tmp/podcraft_mix_test_sp1.wav";
        let p2 = "/tmp/podcraft_mix_test_sp2.wav";
        // 2.0 seconds of 48kHz audio: track 1 active in first & last 0.8s, track 2 quiet floor
        let total_src = 96_000usize;
        let mut s1 = vec![0i16; total_src];
        let mut s2 = vec![0i16; total_src];
        for i in 0..total_src {
            let phase = 2.0 * std::f32::consts::PI * 220.0 * (i as f32 / 48000.0);
            s1[i] = (phase.sin() * 10000.0) as i16;
            s2[i] = 120; // mild room bleed
        }
        write_test_wav_with_list_metadata(p1, &s1);
        write_test_wav_with_list_metadata(p2, &s2);

        let port = ensure_local_audio_http_server();
        let config_body = format!(
            r#"{{
                "recordingMode": "same_room_sync",
                "loudnessAligned": true,
                "autoSoloMode": "natural_ducking",
                "duckAttenuationDb": -20,
                "deClickEnabled": true,
                "deClickStrength": "medium",
                "bgmDuckDb": -18,
                "coldOpenEnabled": false,
                "coldOpenDurationSec": 0,
                "introVoiceoverDurationSec": 0,
                "totalEditedDurationSec": 1.0,
                "tracks": [
                    {{"id":"sp_1","filePath":"{}","syncOffsetMs":0,"autoGainDb":0,"muted":false,"solo":false}},
                    {{"id":"sp_2","filePath":"{}","syncOffsetMs":0,"autoGainDb":0,"muted":false,"solo":false}}
                ],
                "playbackSpans": [
                    {{"editedStartSec":0.0,"editedEndSec":0.5,"sourceStartSec":0.0,"sourceEndSec":0.5}},
                    {{"editedStartSec":0.5,"editedEndSec":1.0,"sourceStartSec":1.2,"sourceEndSec":1.7}}
                ],
                "highlights": [],
                "activeIntervals": [{{"trackId":"sp_1","startMs":0,"endMs":1800}}],
                "laughterRanges": [],
                "trackMutes": [],
                "mouthClickRanges": [],
                "bleepRanges": []
            }}"#,
            p1, p2
        );

        let mut conn = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let post_req = format!(
            "POST /audio-mix-config HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            config_body.len(),
            config_body
        );
        conn.write_all(post_req.as_bytes()).unwrap();
        let mut post_raw = Vec::new();
        conn.read_to_end(&mut post_raw).unwrap();
        let post_str = String::from_utf8_lossy(&post_raw);
        assert!(post_str.starts_with("HTTP/1.1 200 OK"), "resp={}", post_str);
        let split_pos = post_raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let json_val: serde_json::Value =
            serde_json::from_slice(&post_raw[split_pos + 4..]).unwrap();
        assert_eq!(json_val["ok"], true);
        let rev = json_val["rev"].as_u64().unwrap();
        assert_eq!(json_val["totalFrames"].as_u64().unwrap(), 48_000);

        let url = format!("/audio-mix?rev={}", rev);

        // 1. Probe first 2 bytes (AVFoundation signature probe)
        let (h0, b0) = http_get_range(port, &url, "bytes=0-1");
        assert!(h0.starts_with("HTTP/1.1 206 Partial Content"));
        assert_eq!(b0, b"RI");

        // 2. Validate 44-byte RIFF header
        let (_h1, hdr_bytes) = http_get_range(port, &url, "bytes=0-43");
        assert_eq!(hdr_bytes.len(), 44);
        assert_eq!(&hdr_bytes[0..4], b"RIFF");
        assert_eq!(&hdr_bytes[8..12], b"WAVE");
        assert_eq!(&hdr_bytes[36..40], b"data");

        // 3. Odd byte range & chunk-split determinism check across cut point
        let (h_full, pcm_full) = http_get_range(port, &url, "bytes=44-4043");
        assert!(h_full.contains("Content-Length: 4000"));
        assert_eq!(pcm_full.len(), 4000);
        let (_, pcm_part_a) = http_get_range(port, &url, "bytes=44-2043");
        let (_, pcm_part_b) = http_get_range(port, &url, "bytes=2044-4043");
        let mut joined = pcm_part_a;
        joined.extend_from_slice(&pcm_part_b);
        assert_eq!(joined, pcm_full);

        // 4. Mid-cut splice crossfade odd byte range contains non-zero audio
        let (h_cut, pcm_cut) = http_get_range(port, &url, "bytes=47001-51000");
        assert!(h_cut.contains("Content-Length: 4000"));
        assert_eq!(pcm_cut.len(), 4000);
        assert!(pcm_cut.iter().any(|&b| b != 0));
    }

    #[test]
    fn test_non_primary_speaker_speech_preserved_while_noise_floor_ducked() {
        let p_pri = "/tmp/podcraft_ov_pri.wav";
        let p_sec = "/tmp/podcraft_ov_sec.wav";
        let p_noise = "/tmp/podcraft_ov_noise.wav";
        // 1.0s of 48kHz audio:
        // - s_sec: genuine speech on secondary speaker (amplitude 12000)
        // - s_noise: low-level floor noise on secondary track (amplitude 120)
        let total_src = 48_000usize;
        let s_pri = vec![0i16; total_src];
        let mut s_sec = vec![0i16; total_src];
        let mut s_noise = vec![0i16; total_src];
        for i in 0..total_src {
            let phase = 2.0 * std::f32::consts::PI * 440.0 * (i as f32 / 48000.0);
            s_sec[i] = (phase.sin() * 12000.0) as i16;
            s_noise[i] = (phase.sin() * 120.0) as i16;
        }
        write_test_wav_with_list_metadata(p_pri, &s_pri);
        write_test_wav_with_list_metadata(p_sec, &s_sec);
        write_test_wav_with_list_metadata(p_noise, &s_noise);

        let port = ensure_local_audio_http_server();

        let post_and_peak = |sec_path: &str, auto_solo_mode: &str, sec_also_primary: bool| -> i16 {
            let pri_json = if sec_also_primary {
                r#"[{"trackId":"sp_1","startMs":0,"endMs":1000},{"trackId":"sp_2","startMs":0,"endMs":1000}]"#
            } else {
                r#"[{"trackId":"sp_1","startMs":0,"endMs":1000}]"#
            };
            let body = format!(
                r#"{{
                    "recordingMode": "same_room_sync",
                    "loudnessAligned": false,
                    "autoSoloMode": "{}",
                    "duckAttenuationDb": -16,
                    "deClickEnabled": false,
                    "deClickStrength": "medium",
                    "bgmDuckDb": -18,
                    "coldOpenEnabled": false,
                    "coldOpenDurationSec": 0,
                    "introVoiceoverDurationSec": 0,
                    "totalEditedDurationSec": 1.0,
                    "tracks": [
                        {{"id":"sp_1","filePath":"{}","syncOffsetMs":0,"autoGainDb":0,"muted":false,"solo":false}},
                        {{"id":"sp_2","filePath":"{}","syncOffsetMs":0,"autoGainDb":0,"muted":false,"solo":false}}
                    ],
                    "playbackSpans": [
                        {{"editedStartSec":0.0,"editedEndSec":1.0,"sourceStartSec":0.0,"sourceEndSec":1.0}}
                    ],
                    "highlights": [],
                    "activeIntervals": [
                        {{"trackId":"sp_1","startMs":0,"endMs":1000}},
                        {{"trackId":"sp_2","startMs":0,"endMs":1000}}
                    ],
                    "primaryIntervals": {},
                    "laughterRanges": [],
                    "trackMutes": [],
                    "mouthClickRanges": [],
                    "bleepRanges": []
                }}"#,
                auto_solo_mode, p_pri, sec_path, pri_json
            );
            let mut conn = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let req = format!(
                "POST /audio-mix-config HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            conn.write_all(req.as_bytes()).unwrap();
            let mut resp = Vec::new();
            conn.read_to_end(&mut resp).unwrap();
            let split = resp.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            let val: serde_json::Value = serde_json::from_slice(&resp[split + 4..]).unwrap();
            let rev = val["rev"].as_u64().unwrap();

            // Sample middle of 1.0s file (frames 12000..24000 => bytes 44 + 24000 .. 44 + 48000)
            let (_h, pcm) = http_get_range(port, &format!("/audio-mix?rev={}", rev), "bytes=24044-48043");
            pcm.chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]).saturating_abs())
                .max()
                .unwrap_or(0)
        };

        let peak_off = post_and_peak(p_sec, "off", false);
        let peak_ducked = post_and_peak(p_sec, "natural_ducking", false);
        let peak_hard = post_and_peak(p_sec, "hard_mute", false);
        let peak_keep_full = post_and_peak(p_sec, "natural_ducking", true);

        // When another speaker has genuine speech, auto-ducking must preserve full volume for editor handling
        assert!(peak_off > 10500, "peak_off={}", peak_off);
        assert!(peak_keep_full > 10500, "peak_keep_full={}", peak_keep_full);
        assert!(
            peak_ducked > 10500,
            "expected secondary speaker speech preserved in natural_ducking, got peak_ducked={}",
            peak_ducked
        );
        assert!(
            peak_hard > 10500,
            "expected secondary speaker speech preserved in hard_mute, got peak_hard={}",
            peak_hard
        );

        // Low-level noise floor on non-primary track must still be ducked
        let noise_off = post_and_peak(p_noise, "off", false);
        let noise_ducked = post_and_peak(p_noise, "natural_ducking", false);
        let noise_hard = post_and_peak(p_noise, "hard_mute", false);
        assert!(noise_off >= 100, "noise_off={}", noise_off);
        assert!(
            noise_ducked < (noise_off as f32 * 0.20) as i16,
            "expected low-level noise floor ducked in natural_ducking, off={} vs ducked={}",
            noise_off,
            noise_ducked
        );
        assert!(
            noise_hard < (noise_off as f32 * 0.10) as i16,
            "expected low-level noise floor suppressed in hard_mute, off={} vs hard={}",
            noise_off,
            noise_hard
        );
    }

    #[test]
    fn test_single_speaker_echo_noise_suppression_and_phase_aligned_splice() {
        let dir = std::env::temp_dir().join(format!(
            "podcraft_echo_splice_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let sr = 48_000usize;
        let total_frames = sr * 3 / 2; // 1.5s
        let mut s1 = vec![0i16; total_frames];
        let mut s2 = vec![0i16; total_frames];

        for i in 0..total_frames {
            let t = i as f32 / sr as f32;
            if i < sr / 2 {
                // 0.0..0.5s: idle noise floor on both mics (~0.003 @ 1kHz + 200Hz)
                s1[i] = ((2.0 * std::f32::consts::PI * 200.0 * t).sin() * 0.003 * 32767.0) as i16;
                s2[i] = ((2.0 * std::f32::consts::PI * 1000.0 * t).sin() * 0.003 * 32767.0) as i16;
            } else if i < sr {
                // 0.5..1.0s: sp_1 speaks (200Hz @ 0.45), sp_2 captures room echo (1000Hz @ 0.032)
                s1[i] = ((2.0 * std::f32::consts::PI * 200.0 * t).sin() * 0.45 * 32767.0) as i16;
                s2[i] = ((2.0 * std::f32::consts::PI * 1000.0 * t).sin() * 0.032 * 32767.0) as i16;
            } else {
                // 1.0..1.5s: genuine dual-speaker overlap (sp_1 200Hz @ 0.38, sp_2 1000Hz @ 0.35)
                s1[i] = ((2.0 * std::f32::consts::PI * 200.0 * t).sin() * 0.38 * 32767.0) as i16;
                s2[i] = ((2.0 * std::f32::consts::PI * 1000.0 * t).sin() * 0.35 * 32767.0) as i16;
            }
        }

        let p1 = dir.join("sp1.wav");
        let p2 = dir.join("sp2.wav");
        let p1_str = p1.to_string_lossy().to_string();
        let p2_str = p2.to_string_lossy().to_string();
        write_test_wav_with_list_metadata(&p1_str, &s1);
        write_test_wav_with_list_metadata(&p2_str, &s2);

        // Opposite-phase 250Hz sine wave file for testing cut-seam phase alignment & 36ms xfade
        let splice_wav = dir.join("splice.wav");
        let splice_str = splice_wav.to_string_lossy().to_string();
        let splice_samples: Vec<i16> = (0..sr)
            .map(|i| {
                let t = i as f32 / sr as f32;
                ((2.0 * std::f32::consts::PI * 250.0 * t).sin() * 0.55 * 32767.0) as i16
            })
            .collect();
        write_test_wav_with_list_metadata(&splice_str, &splice_samples);

        let port = ensure_local_audio_http_server();

        let post_config = |body: String| -> u64 {
            let mut conn = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let req = format!(
                "POST /audio-mix-config HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            conn.write_all(req.as_bytes()).unwrap();
            let mut resp = Vec::new();
            conn.read_to_end(&mut resp).unwrap();
            let split = resp.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            let val: serde_json::Value = serde_json::from_slice(&resp[split + 4..]).unwrap();
            val["rev"]
                .as_u64()
                .unwrap_or_else(|| panic!("missing rev in response: {}", val))
        };

        let tone_mag_1khz = |pcm: &[u8]| -> f32 {
            let samples: Vec<f32> = pcm
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32)
                .collect();
            let mut cos_acc = 0.0f64;
            let mut sin_acc = 0.0f64;
            let n = samples.len().max(1);
            for (idx, &v) in samples.iter().enumerate() {
                let ang = 2.0 * std::f64::consts::PI * 1000.0 * (idx as f64) / (sr as f64);
                cos_acc += (v as f64) * ang.cos();
                sin_acc += (v as f64) * ang.sin();
            }
            ((2.0 / n as f64) * cos_acc.hypot(sin_acc)) as f32
        };

        let build_echo_cfg = |mode: &str| -> String {
            format!(
                r#"{{
                    "recordingMode": "same_room_sync",
                    "loudnessAligned": false,
                    "autoSoloMode": "{}",
                    "duckAttenuationDb": -16,
                    "deClickEnabled": false,
                    "deClickStrength": "medium",
                    "bgmDuckDb": -18,
                    "coldOpenEnabled": false,
                    "coldOpenDurationSec": 0,
                    "introVoiceoverDurationSec": 0,
                    "totalEditedDurationSec": 1.5,
                    "tracks": [
                        {{"id":"sp_1","filePath":{},"syncOffsetMs":0,"autoGainDb":0.0,"muted":false,"solo":false}},
                        {{"id":"sp_2","filePath":{},"syncOffsetMs":0,"autoGainDb":0.0,"muted":false,"solo":false}}
                    ],
                    "playbackSpans": [
                        {{"editedStartSec":0.0,"editedEndSec":1.5,"sourceStartSec":0.0,"sourceEndSec":1.5}}
                    ],
                    "highlights": [],
                    "activeIntervals": [
                        {{"trackId":"sp_1","startMs":500,"endMs":1500}},
                        {{"trackId":"sp_2","startMs":500,"endMs":1500}}
                    ],
                    "primaryIntervals": [],
                    "laughterRanges": [],
                    "trackMutes": [],
                    "mouthClickRanges": [],
                    "bleepRanges": []
                }}"#,
                mode,
                serde_json::to_string(&p1_str).unwrap(),
                serde_json::to_string(&p2_str).unwrap()
            )
        };

        let rev_off = post_config(build_echo_cfg("off"));
        let rev_duck = post_config(build_echo_cfg("natural_ducking"));

        // 1) Idle noise floor: frames 4800..19200 (0.1s..0.4s)
        let (_h, idle_off) = http_get_range(
            port,
            &format!("/audio-mix?rev={}", rev_off),
            &format!("bytes={}-{}", 44 + 4800 * 2, 44 + 19200 * 2 - 1),
        );
        let (_h, idle_duck) = http_get_range(
            port,
            &format!("/audio-mix?rev={}", rev_duck),
            &format!("bytes={}-{}", 44 + 4800 * 2, 44 + 19200 * 2 - 1),
        );
        let idle_rms_off = {
            let sq: f64 = idle_off
                .chunks_exact(2)
                .map(|c| {
                    let s = i16::from_le_bytes([c[0], c[1]]) as f64;
                    s * s
                })
                .sum();
            (sq / (idle_off.len() / 2) as f64).sqrt()
        };
        let idle_rms_duck = {
            let sq: f64 = idle_duck
                .chunks_exact(2)
                .map(|c| {
                    let s = i16::from_le_bytes([c[0], c[1]]) as f64;
                    s * s
                })
                .sum();
            (sq / (idle_duck.len() / 2) as f64).sqrt()
        };
        assert!(
            idle_rms_duck < idle_rms_off * 0.4,
            "expected idle floor suppressed by noise expander, off={} vs duck={}",
            idle_rms_off,
            idle_rms_duck
        );

        // 2) Single-speaker cross-mic echo: frames 28800..43200 (0.6s..0.9s)
        let (_h, echo_off) = http_get_range(
            port,
            &format!("/audio-mix?rev={}", rev_off),
            &format!("bytes={}-{}", 44 + 28800 * 2, 44 + 43200 * 2 - 1),
        );
        let (_h, echo_duck) = http_get_range(
            port,
            &format!("/audio-mix?rev={}", rev_duck),
            &format!("bytes={}-{}", 44 + 28800 * 2, 44 + 43200 * 2 - 1),
        );
        let mag_echo_off = tone_mag_1khz(&echo_off);
        let mag_echo_duck = tone_mag_1khz(&echo_duck);
        assert!(
            mag_echo_duck < mag_echo_off * 0.16,
            "expected cross-mic room echo suppressed >16dB, off={} vs duck={}",
            mag_echo_off,
            mag_echo_duck
        );

        // 3) Genuine dual-speaker speech: frames 52800..67200 (1.1s..1.4s) stays open
        let (_h, dual_off) = http_get_range(
            port,
            &format!("/audio-mix?rev={}", rev_off),
            &format!("bytes={}-{}", 44 + 52800 * 2, 44 + 67200 * 2 - 1),
        );
        let (_h, dual_duck) = http_get_range(
            port,
            &format!("/audio-mix?rev={}", rev_duck),
            &format!("bytes={}-{}", 44 + 52800 * 2, 44 + 67200 * 2 - 1),
        );
        let mag_dual_off = tone_mag_1khz(&dual_off);
        let mag_dual_duck = tone_mag_1khz(&dual_duck);
        assert!(
            mag_dual_duck > mag_dual_off * 0.85,
            "expected genuine simultaneous dual-speaker audio preserved, off={} vs duck={}",
            mag_dual_off,
            mag_dual_duck
        );

        // 4) Opposite-polarity splice across cut seam stays phase-continuous (no hard step)
        let splice_cfg = format!(
            r#"{{
                "recordingMode": "same_room_sync",
                "loudnessAligned": false,
                "autoSoloMode": "off",
                "duckAttenuationDb": -16,
                "deClickEnabled": false,
                "deClickStrength": "medium",
                "bgmDuckDb": -18,
                "coldOpenEnabled": false,
                "coldOpenDurationSec": 0,
                "introVoiceoverDurationSec": 0,
                "totalEditedDurationSec": 0.70,
                "tracks": [
                    {{"id":"sp_1","filePath":{},"syncOffsetMs":0,"autoGainDb":0.0,"muted":false,"solo":false}}
                ],
                "playbackSpans": [
                    {{"editedStartSec":0.0,"editedEndSec":0.30,"sourceStartSec":0.0,"sourceEndSec":0.30}},
                    {{"editedStartSec":0.30,"editedEndSec":0.70,"sourceStartSec":0.602,"sourceEndSec":1.00}}
                ],
                "highlights": [],
                "activeIntervals": [],
                "primaryIntervals": [],
                "laughterRanges": [],
                "trackMutes": [],
                "mouthClickRanges": [],
                "bleepRanges": []
            }}"#,
            serde_json::to_string(&splice_str).unwrap()
        );
        let rev_splice = post_config(splice_cfg);
        let (_h, splice_pcm) = http_get_range(
            port,
            &format!("/audio-mix?rev={}", rev_splice),
            &format!("bytes={}-{}", 44 + 12000 * 2, 44 + 17280 * 2 - 1), // 0.25s..0.36s across 0.30s splice
        );
        let splice_vals: Vec<i16> = splice_pcm
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();
        let max_step = splice_vals
            .windows(2)
            .map(|w| (w[1] as i32 - w[0] as i32).abs())
            .max()
            .unwrap_or(0);
        // Smooth 250Hz @ 0.55 slope max sample step is ~590; unaligned opposite-phase jump would exceed 16000
        assert!(
            max_step < 2500,
            "expected smooth phase-aligned crossfade across cut seam without click/jump, max_step={}",
            max_step
        );
    }
}
