//! Spawn and monitor the `openocd` binary.

use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};

use crate::LogLine;

/// Shared ring buffer of recent log lines (for error diagnostics on startup failure).
pub type LogRing = Arc<Mutex<VecDeque<String>>>;

#[derive(Debug, thiserror::Error)]
pub enum ProcError {
    #[error("failed to spawn `{0}`: {1}")]
    Spawn(String, String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Handle to the running openocd process.
pub struct ProcHandle {
    /// `None` while running; `Some(code)` after exit (`None` code = killed).
    pub exit: watch::Receiver<Option<Option<i32>>>,
    kill_tx: mpsc::UnboundedSender<()>,
    ring: LogRing,
}

impl ProcHandle {
    /// Force-kill the process (fallback when `shutdown` doesn't take effect).
    pub fn kill(&self) {
        let _ = self.kill_tx.send(());
    }

    pub fn ring(&self) -> LogRing {
        self.ring.clone()
    }
}

pub fn ring_tail(ring: &LogRing, n: usize) -> Vec<String> {
    let guard = ring.lock().unwrap_or_else(|p| p.into_inner());
    guard.iter().rev().take(n).rev().cloned().collect()
}

/// Spawn openocd with `args`. Log lines are streamed to `log_tx`; process
/// exit is reported on the handle's watch channel.
pub async fn spawn(
    binary: &str,
    args: Vec<String>,
    log_tx: mpsc::UnboundedSender<LogLine>,
) -> Result<ProcHandle, ProcError> {
    let mut cmd = Command::new(binary);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| ProcError::Spawn(binary.to_string(), e.to_string()))?;

    let ring: LogRing = Arc::new(Mutex::new(VecDeque::with_capacity(256)));
    if let Some(stdout) = child.stdout.take() {
        spawn_reader(stdout, "stdout", log_tx.clone(), ring.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_reader(stderr, "stderr", log_tx.clone(), ring.clone());
    }

    let (exit_tx, exit_rx) = watch::channel(None);
    let (kill_tx, mut kill_rx) = mpsc::unbounded_channel();
    let mut child = child;
    tokio::spawn(async move {
        tokio::select! {
            status = child.wait() => {
                let code = status.ok().and_then(|s| s.code());
                let _ = exit_tx.send(Some(code));
            }
            _ = kill_rx.recv() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                let _ = exit_tx.send(Some(None));
            }
        }
    });

    Ok(ProcHandle { exit: exit_rx, kill_tx, ring })
}

fn spawn_reader<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    reader: R,
    stream: &'static str,
    log_tx: mpsc::UnboundedSender<LogLine>,
    ring: LogRing,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let line = line.trim_end_matches('\r');
                    if line.is_empty() {
                        continue;
                    }
                    {
                        let mut guard = ring.lock().unwrap_or_else(|p| p.into_inner());
                        if guard.len() >= 256 {
                            guard.pop_front();
                        }
                        guard.push_back(line.to_string());
                    }
                    let _ = log_tx.send(LogLine { stream: stream.to_string(), line: line.to_string() });
                }
                Ok(None) | Err(_) => break,
            }
        }
    });
}
