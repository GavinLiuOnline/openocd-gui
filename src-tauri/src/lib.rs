//! Tauri IPC layer: thin wrappers around `openocd-core::Session`.

use std::sync::Arc;

use openocd_core::{ProbeOutcome, Session, StartConfig, TargetInfo};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// Session slot shared with background tasks (exit watcher).
#[derive(Default)]
struct AppState {
    session: Arc<Mutex<Option<Arc<Session>>>>,
}

type SessionState<'a> = State<'a, AppState>;

fn take_session(state: &SessionState) -> Result<Arc<Session>, String> {
    state
        .session
        .try_lock()
        .map_err(|_| "busy".to_string())?
        .clone()
        .ok_or_else(|| "not connected".to_string())
}

/// OpenOCD's telnet command server silently drops every non-ASCII byte, so
/// `/home/me/下载/fw.hex` would reach it as `/home/me//fw.hex`. Files outside an
/// ASCII-only path are staged under a stable temp name; `None` means the path
/// already survives untouched.
fn ascii_staging_path(path: &str, tag: &str) -> Result<Option<String>, String> {
    if path.is_ascii() {
        return Ok(None);
    }
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| e.is_ascii())
        .unwrap_or("bin");
    let dst = std::env::temp_dir().join(format!("openocd-gui-{tag}{:x}.{ext}", hasher.finish()));
    let dst = dst.to_string_lossy().to_string();
    if !dst.is_ascii() {
        return Err(format!("路径与临时目录均含非 ASCII 字符，无法通过 telnet 传给 OpenOCD: {path}"));
    }
    Ok(Some(dst))
}

fn stage_firmware(path: &str) -> Result<String, String> {
    match ascii_staging_path(path, "")? {
        Some(dst) => {
            std::fs::copy(path, &dst).map_err(|e| format!("复制固件到 {dst} 失败: {e}"))?;
            Ok(dst)
        }
        None => Ok(path.to_string()),
    }
}

/// Mirror image of `stage_firmware`: a dump is *written* by openocd, so the
/// user's (possibly non-ASCII) destination becomes `Some(dst)` and openocd is
/// told to write the ASCII stand-in.
fn stage_dump_target(path: &str) -> Result<(String, Option<String>), String> {
    match ascii_staging_path(path, "dump-")? {
        Some(tmp) => {
            let _ = std::fs::remove_file(&tmp);
            Ok((tmp, Some(path.to_string())))
        }
        None => Ok((path.to_string(), None)),
    }
}

/// Move an ASCII temp dump back to the destination the user picked: rename when
/// both live on the same filesystem, copy otherwise (e.g. /tmp on tmpfs).
fn finish_dump(tmp: &str, dst: Option<&str>) -> Result<String, String> {
    let Some(dst) = dst else { return Ok(tmp.to_string()) };
    if std::fs::rename(tmp, dst).is_err() {
        std::fs::copy(tmp, dst).map_err(|e| format!("读取成功但写入 {dst} 失败: {e}"))?;
        let _ = std::fs::remove_file(tmp);
    }
    Ok(dst.to_string())
}

#[tauri::command]
async fn list_scripts(binary: Option<String>) -> Result<openocd_core::scripts::ScriptLists, String> {
    let binary = binary.unwrap_or_else(|| "openocd".to_string());
    Ok(openocd_core::scripts::list_scripts(&binary))
}

#[tauri::command]
async fn session_start(
    app: AppHandle,
    state: SessionState<'_>,
    cfg: StartConfig,
) -> Result<TargetInfo, String> {
    {
        let guard = state.session.lock().await;
        if guard.is_some() {
            return Err("session already running".into());
        }
    }

    let (log_tx, mut log_rx) = tokio::sync::mpsc::unbounded_channel::<openocd_core::LogLine>();
    let (session, mut exit_rx) =
        Session::start(cfg, log_tx).await.map_err(|e| e.to_string())?;
    let session = Arc::new(session);

    // Forward process logs to the frontend.
    let app_log = app.clone();
    tokio::spawn(async move {
        while let Some(line) = log_rx.recv().await {
            let _ = app_log.emit("ocd-log", &line);
        }
    });

    // Watch for process exit; notify frontend and clear the slot.
    let app_exit = app.clone();
    let slot = state.session.clone();
    let session_for_exit = session.clone();
    tokio::spawn(async move {
        loop {
            let exited = exit_rx.changed().await.is_err() || exit_rx.borrow().is_some();
            if exited {
                let code = exit_rx.borrow().unwrap_or(None);
                let _ = app_exit.emit("ocd-exit", code);
                // Give in-flight commands a moment, then drop the session.
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                if let Ok(mut guard) = slot.try_lock() {
                    if guard.as_ref().map(|s| Arc::ptr_eq(s, &session_for_exit)).unwrap_or(false) {
                        *guard = None;
                    }
                }
                break;
            }
        }
    });

    *state.session.lock().await = Some(session.clone());

    // Initial target info; on failure the session stays up (user can inspect logs).
    let mut info = match session.target_info().await {
        Ok(info) => info,
        Err(e) => {
            let _ = app.emit("ocd-log", openocd_core::LogLine {
                stream: "stderr".into(),
                line: format!("target info: {e}"),
            });
            return Ok(TargetInfo::default());
        }
    };
    // A bank reporting size 0 means the cfg's examine-end script died before the
    // driver could probe; recover the capacity now so Flash/Dump work at once.
    if info.flash_banks.iter().any(|b| b.size == 0) {
        let line = match session.probe_flash_sizes().await {
            Ok(out) => {
                info = out.info;
                format!("flash size probe: {}", out.report.trim().replace('\n', " / "))
            }
            Err(e) => format!("flash size probe failed: {e}"),
        };
        let _ = app.emit("ocd-log", openocd_core::LogLine { stream: "stderr".into(), line });
    }
    Ok(info)
}

#[tauri::command]
async fn session_stop(state: SessionState<'_>) -> Result<(), String> {
    let session = {
        let mut guard = state.session.lock().await;
        guard.take()
    };
    if let Some(s) = session {
        s.stop().await;
    }
    Ok(())
}

#[tauri::command]
async fn get_target_info(state: SessionState<'_>) -> Result<TargetInfo, String> {
    let s = take_session(&state)?;
    s.target_info().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_memory(state: SessionState<'_>, addr: u64, count: u32) -> Result<MemoryBlock, String> {
    let s = take_session(&state)?;
    let words = s.read_words(addr, count).await.map_err(|e| e.to_string())?;
    Ok(MemoryBlock { addr, words })
}

#[tauri::command]
async fn flash_program(
    state: SessionState<'_>,
    path: String,
    offset: u64,
    erase: bool,
    verify: bool,
    reset: bool,
) -> Result<String, String> {
    let s = take_session(&state)?;
    let staged = stage_firmware(&path)?;
    let report = s
        .flash_program(&staged, offset, erase, verify, reset)
        .await
        .map_err(|e| e.to_string())?;
    Ok(with_staged_note(report, &path, &staged))
}

#[tauri::command]
async fn flash_verify(state: SessionState<'_>, path: String, offset: u64) -> Result<String, String> {
    let s = take_session(&state)?;
    let staged = stage_firmware(&path)?;
    let report = s.flash_verify(&staged, offset).await.map_err(|e| e.to_string())?;
    Ok(with_staged_note(report, &path, &staged))
}

fn with_staged_note(report: String, original: &str, staged: &str) -> String {
    if staged == original {
        report
    } else {
        format!("{report}\n[已复制到纯 ASCII 临时路径烧录: {staged}]")
    }
}

#[tauri::command]
async fn flash_erase_all(state: SessionState<'_>) -> Result<String, String> {
    let s = take_session(&state)?;
    s.flash_erase_all().await.map_err(|e| e.to_string())
}

/// Read a memory range into a binary file on disk.
#[tauri::command]
async fn dump_memory_bin(
    state: SessionState<'_>,
    path: String,
    addr: u64,
    size: u64,
) -> Result<String, String> {
    let s = take_session(&state)?;
    let (tmp, dst) = stage_dump_target(&path)?;
    let report = s.dump_memory_bin(&tmp, addr, size).await.map_err(|e| e.to_string())?;
    let out = finish_dump(&tmp, dst.as_deref())?;
    let written = std::fs::metadata(&out).map_err(|e| format!("{out}: {e}"))?.len();
    Ok(format!("{report}\n已保存 {written} 字节 → {out}"))
}

/// Re-probe flash banks whose size came back as 0.
#[tauri::command]
async fn flash_probe_sizes(state: SessionState<'_>) -> Result<ProbeOutcome, String> {
    let s = take_session(&state)?;
    s.probe_flash_sizes().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn reset_target(state: SessionState<'_>, mode: String) -> Result<(), String> {
    let s = take_session(&state)?;
    s.reset(&mode).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn halt_target(state: SessionState<'_>) -> Result<(), String> {
    let s = take_session(&state)?;
    s.halt().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn resume_target(state: SessionState<'_>) -> Result<(), String> {
    let s = take_session(&state)?;
    s.resume().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn raw_command(state: SessionState<'_>, cmd: String) -> Result<String, String> {
    let s = take_session(&state)?;
    s.exec(&cmd, std::time::Duration::from_secs(30)).await.map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct MemoryBlock {
    pub addr: u64,
    pub words: Vec<u32>,
}

#[cfg(test)]
mod tests {
    use super::{ascii_staging_path, finish_dump, stage_dump_target, stage_firmware};

    #[test]
    fn non_ascii_paths_are_staged_to_ascii_copies() {
        let src = std::env::temp_dir().join(format!("openocd-gui-测试-{}.hex", std::process::id()));
        std::fs::write(&src, b":00000001FF\n").unwrap();
        let src_str = src.to_string_lossy().to_string();
        assert!(!src_str.is_ascii());

        let staged = stage_firmware(&src_str).unwrap();
        assert!(staged.is_ascii(), "staged path must survive telnet: {staged}");
        assert_eq!(std::fs::read_to_string(&staged).unwrap(), ":00000001FF\n");

        assert_eq!(stage_firmware("/tmp/fw.hex").unwrap(), "/tmp/fw.hex");
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(staged);
    }

    #[test]
    fn dumps_are_moved_back_from_the_ascii_staging_name() {
        let dst = std::env::temp_dir().join(format!("openocd-gui-转储-{}.bin", std::process::id()));
        let dst_str = dst.to_string_lossy().to_string();
        assert!(!dst_str.is_ascii());

        let (tmp, final_path) = stage_dump_target(&dst_str).unwrap();
        assert!(tmp.is_ascii() && tmp != dst_str);
        std::fs::write(&tmp, [0xA5u8; 8]).unwrap();

        let out = finish_dump(&tmp, final_path.as_deref()).unwrap();
        assert_eq!(out, dst_str);
        assert_eq!(std::fs::read(&out).unwrap().len(), 8);
        assert!(!std::path::Path::new(&tmp).exists(), "staging file must not linger");

        assert_eq!(stage_dump_target("/tmp/fw.bin").unwrap(), ("/tmp/fw.bin".into(), None));
        assert_eq!(finish_dump("/tmp/fw.bin", None).unwrap(), "/tmp/fw.bin");
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn an_ascii_temp_dir_leaves_no_staging_option() {
        // Nothing to do when the path is already safe for telnet.
        assert_eq!(ascii_staging_path("/tmp/fw.hex", "").unwrap(), None);
        assert!(ascii_staging_path("/tmp/下载/fw.hex", "").unwrap().is_some());
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_scripts,
            session_start,
            session_stop,
            get_target_info,
            read_memory,
            flash_program,
            flash_verify,
            flash_erase_all,
            dump_memory_bin,
            flash_probe_sizes,
            reset_target,
            halt_target,
            resume_target,
            raw_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
