//! OpenOCD driver core.
//!
//! - `process`: spawn/monitor the `openocd` binary, capture stdout/stderr logs
//! - `telnet`:   minimal telnet client for OpenOCD's command server (port 4444)
//! - `command`:  high-level session (start, exec, parse targets/flash/memory)

pub mod command;
pub mod process;
pub mod scripts;
pub mod telnet;

pub use command::{parse_flash_banks, parse_mdw, parse_targets, FlashBank, Session, StartConfig, TargetInfo, TargetState};

/// One captured log line from the openocd process.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LogLine {
    /// "stdout" | "stderr"
    pub stream: String,
    pub line: String,
}
