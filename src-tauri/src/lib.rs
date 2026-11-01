//! Tauri IPC layer: thin wrappers around `openocd-core::Session`.

use std::sync::Arc;

use openocd_core::{Session, StartConfig, TargetInfo};
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
    match session.target_info().await {
        Ok(info) => Ok(info),
        Err(e) => {
            let _ = app.emit("ocd-log", openocd_core::LogLine {
                stream: "stderr".into(),
                line: format!("target info: {e}"),
            });
            Ok(TargetInfo::default())
        }
    }
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
    s.flash_program(&path, offset, erase, verify, reset).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn flash_verify(state: SessionState<'_>, path: String, offset: u64) -> Result<String, String> {
    let s = take_session(&state)?;
    s.flash_verify(&path, offset).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn flash_erase_all(state: SessionState<'_>) -> Result<String, String> {
    let s = take_session(&state)?;
    s.flash_erase_all().await.map_err(|e| e.to_string())
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
            reset_target,
            halt_target,
            resume_target,
            raw_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
