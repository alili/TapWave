use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

struct LiveProc {
    child: Child,
    stdin: Option<ChildStdin>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveEventPayload {
    session_id: String,
    line: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartEnvelope {
    session_id: Option<String>,
    output_dir: Option<String>,
    title: Option<String>,
}

static LIVE_PROCS: OnceLock<Mutex<HashMap<String, LiveProc>>> = OnceLock::new();

fn procs_lock() -> &'static Mutex<HashMap<String, LiveProc>> {
    LIVE_PROCS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sanitize_title(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        if ch.is_alphanumeric() || ch == '-' || ch == '_' || ('\u{4e00}'..='\u{9fff}').contains(&ch)
        {
            out.push(ch);
        } else if ch.is_whitespace() && !out.ends_with('-') {
            out.push('-');
        }
        if out.chars().count() >= 32 {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed
    }
}

fn format_utc_compact_timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Civil date conversion (Howard Hinnant algorithm) in local offset (+08:00 fallback or UTC)
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let hh = rem / 3600;
    let mm = (rem % 3600) / 60;
    let ss = rem % 60;

    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let yr = y + if m <= 2 { 1 } else { 0 };

    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", yr, m, d, hh, mm, ss)
}

fn resolve_default_output_dir(title: &str) -> Result<PathBuf, String> {
    let base = crate::get_user_home_dir()
        .ok_or_else(|| "无法获取用户主目录以创建录制文件夹".to_string())?
        .join("TapWave Recordings");
    let folder = format!("{}-{}", format_utc_compact_timestamp(), sanitize_title(title));
    Ok(base.join(folder))
}

#[tauri::command]
pub async fn live_session_start(app: AppHandle, start_json: String) -> Result<String, String> {
    let env: StartEnvelope =
        serde_json::from_str(&start_json).map_err(|e| format!("start_json 格式无效: {}", e))?;
    let session_id = env
        .session_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "live_default".to_string());

    let output_dir_str = match env.output_dir.as_deref().map(str::trim) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => resolve_default_output_dir(env.title.as_deref().unwrap_or("录制"))?
            .to_string_lossy()
            .to_string(),
    };
    fs::create_dir_all(&output_dir_str)
        .map_err(|e| format!("创建录制目录失败 ({}): {}", output_dir_str, e))?;

    let mut start_val: serde_json::Value =
        serde_json::from_str(&start_json).map_err(|e| e.to_string())?;
    if let Some(obj) = start_val.as_object_mut() {
        obj.insert(
            "outputDir".to_string(),
            serde_json::Value::String(output_dir_str.clone()),
        );
        obj.insert(
            "sessionId".to_string(),
            serde_json::Value::String(session_id.clone()),
        );
    }
    let final_start_line = serde_json::to_string(&start_val).map_err(|e| e.to_string())?;

    let script = crate::find_sidecar_script(&app)?;
    let py_bin = crate::find_python_bin();
    let models_dir = crate::find_models_dir(&app);

    let mut child = Command::new(&py_bin)
        .env("TAPWAVE_MODELS_DIR", &models_dir)
        .arg("-u")
        .arg(script)
        .arg("live")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动实时录制 Sidecar 失败 ({}): {}", py_bin, e))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法打开 Sidecar stdin".to_string())?;
    stdin
        .write_all(format!("{}\n", final_start_line).as_bytes())
        .map_err(|e| format!("写入 start 指令失败: {}", e))?;
    let _ = stdin.flush();

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法打开 Sidecar stdout".to_string())?;
    let stderr = child.stderr.take();

    if let Ok(mut guard) = procs_lock().lock() {
        if let Some(mut old) = guard.remove(&session_id) {
            let _ = old.child.kill();
        }
        guard.insert(
            session_id.clone(),
            LiveProc {
                child,
                stdin: Some(stdin),
            },
        );
    }

    // Drain stderr on a dedicated thread so the pipe buffer never blocks Python
    if let Some(err_stream) = stderr {
        let sid_err = session_id.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(err_stream);
            for line in reader.lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    eprintln!("[live-sidecar:{}] {}", sid_err, line);
                }
            }
        });
    }

    // Forward stdout lines to frontend
    let app_out = app.clone();
    let sid_out = session_id.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                let _ = app_out.emit(
                    "live-session-event",
                    LiveEventPayload {
                        session_id: sid_out.clone(),
                        line: trimmed.to_string(),
                    },
                );
            }
        }
        let _ = app_out.emit(
            "live-session-event",
            LiveEventPayload {
                session_id: sid_out.clone(),
                line: r#"{"type":"process_exit"}"#.to_string(),
            },
        );
        if let Ok(mut guard) = procs_lock().lock() {
            if let Some(mut proc_entry) = guard.remove(&sid_out) {
                let _ = proc_entry.child.wait();
            }
        }
    });

    Ok(output_dir_str)
}

#[tauri::command]
pub async fn live_session_send(session_id: String, lines: String) -> Result<(), String> {
    let mut guard = procs_lock()
        .lock()
        .map_err(|_| "Live session lock poisoned".to_string())?;
    let entry = guard
        .get_mut(&session_id)
        .ok_or_else(|| format!("录制会话不存在或已结束: {}", session_id))?;
    let stdin = entry
        .stdin
        .as_mut()
        .ok_or_else(|| "录制会话 stdin 已关闭".to_string())?;
    stdin
        .write_all(lines.as_bytes())
        .map_err(|e| format!("写入音频/指令失败: {}", e))?;
    if !lines.ends_with('\n') {
        stdin
            .write_all(b"\n")
            .map_err(|e| format!("写入换行失败: {}", e))?;
    }
    let _ = stdin.flush();
    Ok(())
}

#[tauri::command]
pub async fn live_session_stop(session_id: String) -> Result<(), String> {
    {
        let mut guard = procs_lock()
            .lock()
            .map_err(|_| "Live session lock poisoned".to_string())?;
        if let Some(entry) = guard.get_mut(&session_id) {
            if let Some(stdin) = entry.stdin.as_mut() {
                let _ = stdin.write_all(b"{\"type\":\"stop\"}\n");
                let _ = stdin.flush();
            }
            entry.stdin = None;
        }
    }

    std::thread::spawn(move || {
        for _ in 0..60 {
            std::thread::sleep(Duration::from_secs(1));
            let still_running = procs_lock()
                .lock()
                .map(|g| g.contains_key(&session_id))
                .unwrap_or(false);
            if !still_running {
                return;
            }
        }
        if let Ok(mut guard) = procs_lock().lock() {
            if let Some(mut entry) = guard.remove(&session_id) {
                let _ = entry.child.kill();
                let _ = entry.child.wait();
            }
        }
    });

    Ok(())
}

pub fn kill_all() {
    if let Ok(mut guard) = procs_lock().lock() {
        for (_id, mut entry) in guard.drain() {
            let _ = entry.child.kill();
            let _ = entry.child.wait();
        }
    }
}
