//! High-level OpenOCD session: lifecycle, typed operations, output parsers.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch, Mutex};

use crate::process::{ring_tail, spawn, ProcHandle};
use crate::telnet::{TelnetClient, TelnetError};
use crate::LogLine;

const Q: Duration = Duration::from_secs(5);
const SHORT: Duration = Duration::from_secs(15);
const LONG: Duration = Duration::from_secs(300);
/// Whole-chip reads over a 1 MHz jumper-wired ST-Link take minutes, not seconds.
const DUMP: Duration = Duration::from_secs(1800);

/// STM32 FLASH_SIZE option byte: the low 16 bits hold the capacity in KB. Only
/// used as a fallback when the flash bank driver failed to report a size.
const FLASH_SIZE_REGS: &[(u64, &str)] = &[
    (0x1FFF_F7CC, "STM32F0/F1/F3"),
    (0x1FFF_7A22, "STM32F2/F4/F7/L/L+"),
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct StartConfig {
    /// Path or name of the openocd binary.
    pub binary: String,
    /// Config files passed via `-f` (interface/target/board cfg).
    pub config_files: Vec<String>,
    /// Custom commands passed via `-c` (applied after config files).
    pub custom_cmds: Vec<String>,
    pub telnet_port: u16,
    pub gdb_port: u16,
    pub tcl_port: u16,
    /// Extra search dir for scripts (`-s`).
    pub scripts_dir: Option<String>,
    pub extra_args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetState {
    pub index: u32,
    pub name: String,
    #[serde(rename = "type")]
    pub target_type: String,
    pub state: String,
    pub current: bool,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlashBank {
    pub index: u32,
    pub name: String,
    pub base: u64,
    pub size: u64,
    /// Size recovered from the FLASH_SIZE option byte rather than from a
    /// successful bank probe; OpenOCD itself still does not know the geometry.
    #[serde(default)]
    pub inferred: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ProbeOutcome {
    pub info: TargetInfo,
    pub report: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TargetInfo {
    pub version: String,
    pub targets: Vec<TargetState>,
    pub flash_banks: Vec<FlashBank>,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("{0}")]
    Msg(String),
    #[error("openocd exited (code {0:?})")]
    Exited(Option<i32>),
    #[error("telnet: {0}")]
    Telnet(#[from] TelnetError),
    #[error("operation timed out")]
    Timeout,
}

impl From<tokio::time::error::Elapsed> for SessionError {
    fn from(_: tokio::time::error::Elapsed) -> Self {
        SessionError::Timeout
    }
}

pub struct Session {
    proc: ProcHandle,
    telnet: Mutex<TelnetClient>,
    pub cfg: StartConfig,
}

impl Session {
    /// Spawn openocd and attach to its telnet command server.
    pub async fn start(
        cfg: StartConfig,
        log_tx: mpsc::UnboundedSender<LogLine>,
    ) -> Result<(Self, watch::Receiver<Option<Option<i32>>>), SessionError> {
        let mut args: Vec<String> = Vec::new();
        if let Some(dir) = &cfg.scripts_dir {
            args.push("-s".into());
            args.push(dir.clone());
        }
        for f in &cfg.config_files {
            args.push("-f".into());
            args.push(f.clone());
        }
        for c in &cfg.custom_cmds {
            if !c.trim().is_empty() {
                args.push("-c".into());
                args.push(c.trim().to_string());
            }
        }
        // Ports are applied last so they override any values from config files.
        args.push("-c".into());
        args.push(format!("gdb_port {}", cfg.gdb_port));
        args.push("-c".into());
        args.push(format!("telnet_port {}", cfg.telnet_port));
        args.push("-c".into());
        args.push(format!("tcl_port {}", cfg.tcl_port));
        args.extend(cfg.extra_args.iter().cloned());

        let handle = spawn(&cfg.binary, args, log_tx).await.map_err(|e| SessionError::Msg(e.to_string()))?;
        let ring = handle.ring();
        let mut exit = handle.exit.clone();

        // Wait for the telnet server to come up (or the process to die).
        let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
        let mut telnet = loop {
            if exit.borrow_and_update().is_some() {
                let code = exit.borrow().unwrap_or(None);
                let tail = ring_tail(&ring, 15).join("\n");
                return Err(SessionError::Msg(format!(
                    "openocd exited during startup (code {code:?}):\n{tail}"
                )));
            }
            match TelnetClient::connect(cfg.telnet_port, Duration::from_millis(250)).await {
                Ok(t) => break t,
                Err(_) if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
                Err(e) => {
                    let tail = ring_tail(&ring, 15).join("\n");
                    handle.kill();
                    return Err(SessionError::Msg(format!("cannot reach telnet port {}: {e}\n{tail}", cfg.telnet_port)));
                }
            }
        };
        telnet.read_until_prompt(Duration::from_secs(5)).await?;

        let session = Self {
            proc: handle,
            telnet: Mutex::new(telnet),
            cfg,
        };
        Ok((session, exit))
    }

    /// Whether the underlying process has exited.
    pub fn has_exited(&self) -> bool {
        self.proc.exit.borrow().is_some()
    }

    pub fn kill(&self) {
        self.proc.kill();
    }

    /// Execute a raw command and return the response text (echo stripped).
    pub async fn exec(&self, cmd: &str, t: Duration) -> Result<String, SessionError> {
        if self.has_exited() {
            return Err(SessionError::Exited(None));
        }
        let mut tel = self.telnet.lock().await;
        if self.has_exited() {
            return Err(SessionError::Exited(None));
        }
        tel.send(cmd).await?;
        let resp = tel.read_until_prompt(t).await?;
        let resp = resp.trim().to_string();
        // Strip the echoed command (first line, when it matches).
        let stripped = match resp.find('\n') {
            Some(i) if resp[..i].trim().eq_ignore_ascii_case(cmd.trim()) => resp[i + 1..].trim().to_string(),
            _ => resp,
        };
        Ok(stripped)
    }

    pub async fn version(&self) -> Result<String, SessionError> {
        let v = self.exec("version", Q).await?;
        Ok(v.lines().next().unwrap_or("").trim().to_string())
    }

    pub async fn target_info(&self) -> Result<TargetInfo, SessionError> {
        let version = self.version().await?;
        let targets = self.exec("targets", Q).await?;
        let targets = parse_targets(&targets).map_err(SessionError::Msg)?;
        let banks_raw = self.exec("flash banks", Q).await?;
        let flash_banks = parse_flash_banks(&banks_raw).map_err(SessionError::Msg)?;
        Ok(TargetInfo { version, targets, flash_banks })
    }

    /// Recover the flash capacity for banks `flash banks` reports as size 0.
    ///
    /// OpenOCD only sets `size` when the driver's `probe` runs, and a target cfg
    /// whose `examine-end` event script fails (wrong DBGMCU base for the actual
    /// part, or a flaky SWD link) leaves the bank unprobed. An explicit
    /// `flash probe` normally fixes it; the FLASH_SIZE option byte is the
    /// fallback so the UI can still offer a usable size.
    pub async fn probe_flash_sizes(&self) -> Result<ProbeOutcome, SessionError> {
        let mut report = String::new();
        let targets = self.current_targets().await?;
        if targets.iter().any(|t| t.current && t.state != "halted") {
            report.push_str("target was running -> halting for probing\n");
            // Carry on regardless: if `flash probe` then fails, its own error text
            // is far more useful than an early bail-out from here.
            if let Err(e) = self.halt().await {
                report.push_str(&format!("halt failed: {e}\n"));
            }
        }

        let mut banks = self.current_banks().await?;
        for idx in banks.iter().filter(|b| b.size == 0).map(|b| b.index).collect::<Vec<_>>() {
            let r = self.exec(&format!("flash probe {idx}"), LONG).await?;
            report.push_str(&format!("flash probe {idx}: {}\n", r.replace('\n', " / ")));
        }
        banks = self.current_banks().await?;

        if banks.iter().any(|b| b.size == 0) {
            match self.read_flash_size_option_byte().await {
                Some((kb, reg, family)) => {
                    for b in banks.iter_mut().filter(|b| b.size == 0) {
                        b.size = kb * 1024;
                        b.inferred = true;
                    }
                    report.push_str(&format!(
                        "bank probe still failed; FLASH_SIZE ({family} @ 0x{reg:x}) = {kb} KB used instead\n"
                    ));
                }
                None => report.push_str(
                    "FLASH_SIZE option byte unreadable: check the SWD link and that the target cfg matches the part\n",
                ),
            }
        }

        let targets = self.current_targets().await?;
        let version = self.version().await?;
        Ok(ProbeOutcome { info: TargetInfo { version, targets, flash_banks: banks }, report })
    }

    async fn current_targets(&self) -> Result<Vec<TargetState>, SessionError> {
        let raw = self.exec("targets", Q).await?;
        parse_targets(&raw).map_err(SessionError::Msg)
    }

    async fn current_banks(&self) -> Result<Vec<FlashBank>, SessionError> {
        let raw = self.exec("flash banks", Q).await?;
        parse_flash_banks(&raw).map_err(SessionError::Msg)
    }

    /// `(kilobytes, register, family)` from the first FLASH_SIZE option byte that
    /// reads back a plausible capacity.
    async fn read_flash_size_option_byte(&self) -> Option<(u64, u64, &'static str)> {
        for &(reg, family) in FLASH_SIZE_REGS {
            let Ok(words) = self.read_words(reg, 1).await else { continue };
            let Some(kb) = words.first().and_then(|w| flash_size_kb(*w)) else { continue };
            return Some((kb, reg, family));
        }
        None
    }

    /// Dump `size` bytes of the target's memory map into a binary file. OpenOCD
    /// writes the file itself (`dump_image`), so the data never crosses the
    /// telnet socket or the IPC boundary.
    pub async fn dump_memory_bin(&self, path: &str, base: u64, size: u64) -> Result<String, SessionError> {
        if size == 0 {
            return Err(SessionError::Msg("size must be > 0".into()));
        }
        let mut report = String::new();
        // Reading a live core's bus gives torn results, and on an STM32 that has
        // entered Sleep the clock is gated, so park the target first.
        match self.halt().await {
            Ok(()) => report.push_str("halted target\n"),
            Err(e) => report.push_str(&format!("halt did not succeed, reading anyway: {e}\n")),
        }
        // `dump_image` reads 32-bit words; round up so nothing is silently lost.
        let rounded = size.div_ceil(4) * 4;
        if rounded != size {
            report.push_str(&format!("size rounded up to {rounded} bytes (word access)\n"));
        }
        let r = self
            .exec(&format!("dump_image \"{path}\" 0x{base:x} {rounded}"), DUMP)
            .await?;
        if has_error(&r) {
            return Err(SessionError::Msg(format!("dump_image: {r}")));
        }
        report.push_str(&r);
        Ok(report)
    }

    /// Read `count` 32-bit words starting at `addr` (little-endian byte order
    /// on the target is the caller's concern; words are returned as-is).
    pub async fn read_words(&self, addr: u64, count: u32) -> Result<Vec<u32>, SessionError> {
        let mut out = Vec::with_capacity(count as usize);
        let mut cur = addr;
        let mut remaining = count;
        while remaining > 0 {
            let n = remaining.min(1024);
            let resp = self.exec(&format!("mdw 0x{cur:x} {n}"), SHORT).await?;
            if has_error(&resp) {
                return Err(SessionError::Msg(resp));
            }
            let words = parse_mdw(&resp).map_err(SessionError::Msg)?;
            if words.len() != n as usize {
                return Err(SessionError::Msg(format!(
                    "mdw returned {} words, expected {n}",
                    words.len()
                )));
            }
            out.extend(words);
            cur += n as u64 * 4;
            remaining -= n;
        }
        Ok(out)
    }

    /// Program a flash image (hex/bin/elf). Composed from primitive commands
    /// (NOT the `program` command, which shuts openocd down).
    pub async fn flash_program(
        &self,
        path: &str,
        offset: u64,
        erase: bool,
        verify: bool,
        reset: bool,
    ) -> Result<String, SessionError> {
        let mut report = String::new();
        let quoted = format!("\"{}\"", path);
        let offset_arg = if offset != 0 { format!(" 0x{offset:x}") } else { String::new() };

        if erase {
            self.reset("halt").await?;
            let banks = self.exec("flash banks", Q).await?;
            let banks = parse_flash_banks(&banks).map_err(SessionError::Msg)?;
            for b in &banks {
                let r = self.exec(&format!("flash erase_sector {} 0 last", b.index), LONG).await?;
                if has_error(&r) {
                    return Err(SessionError::Msg(format!("erase bank {}: {r}", b.index)));
                }
            }
            report.push_str(&format!("erased {} bank(s)\n", banks.len()));
        }

        self.exec("reset halt", Q).await?;
        // `erase` keyword makes OpenOCD erase exactly the sectors the image covers;
        // without it a write onto non-blank cells fails with "not erased before writing".
        let r = self
            .exec(&format!("flash write_image erase {quoted}{offset_arg}"), LONG)
            .await?;
        if has_error(&r) {
            return Err(SessionError::Msg(format!("write_image: {r}")));
        }
        report.push_str(&r);

        if verify {
            let r = self.exec(&format!("verify_image {quoted}{offset_arg}"), LONG).await?;
            if has_error(&r) {
                return Err(SessionError::Msg(format!("verify: {r}")));
            }
            report.push_str(&r);
        }

        if reset {
            let _ = self.exec("reset run", Q).await?;
            report.push_str("\nreset run");
        }
        Ok(report)
    }

    pub async fn flash_verify(&self, path: &str, offset: u64) -> Result<String, SessionError> {
        let offset_arg = if offset != 0 { format!(" 0x{offset:x}") } else { String::new() };
        let r = self.exec(&format!("verify_image \"{}\"{offset_arg}", path), LONG).await?;
        if has_error(&r) {
            return Err(SessionError::Msg(r));
        }
        Ok(r)
    }

    /// Erase all flash banks (target must support `erase_sector`).
    pub async fn flash_erase_all(&self) -> Result<String, SessionError> {
        self.reset("halt").await?;
        let banks_raw = self.exec("flash banks", Q).await?;
        let banks = parse_flash_banks(&banks_raw).map_err(SessionError::Msg)?;
        let mut report = String::new();
        for b in &banks {
            let r = self.exec(&format!("flash erase_sector {} 0 last", b.index), LONG).await?;
            if has_error(&r) {
                return Err(SessionError::Msg(format!("erase bank {}: {r}", b.index)));
            }
            let check = self.exec(&format!("flash erase_check {}", b.index), LONG).await?;
            report.push_str(&check);
        }
        Ok(report)
    }

    /// mode: "run" | "halt" | "init"
    pub async fn reset(&self, mode: &str) -> Result<(), SessionError> {
        let r = self.exec(&format!("reset {mode}"), SHORT).await?;
        if has_error(&r) {
            return Err(SessionError::Msg(r));
        }
        Ok(())
    }

    pub async fn halt(&self) -> Result<(), SessionError> {
        let r = self.exec("halt", SHORT).await?;
        if has_error(&r) {
            return Err(SessionError::Msg(r));
        }
        Ok(())
    }

    pub async fn resume(&self) -> Result<(), SessionError> {
        let r = self.exec("resume", SHORT).await?;
        if has_error(&r) {
            return Err(SessionError::Msg(r));
        }
        Ok(())
    }

    /// Graceful shutdown, then force kill if needed.
    pub async fn stop(&self) {
        let _ = self.exec("shutdown", Q).await;
        let mut exit = self.proc.exit.clone();
        for _ in 0..30 {
            if exit.borrow_and_update().is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.proc.kill();
    }
}

/// Heuristic: openocd error lines start with "Error" / "invalid command" /
/// "Timeout", and failure reports contain "failed".
fn has_error(text: &str) -> bool {
    text.lines().any(|l| {
        let l = l.trim_start();
        l.starts_with("Error")
            || l.starts_with("invalid command")
            || l.starts_with("Timeout")
            || l.contains("failed")
    })
}

/// Parse `mdw` output lines like:
///   "0x08000000: ffffffff ffffffff ffffffff ffffffff"
///   "0x08000000: 0xFFFFFFFF 0xFFFFFFFF ..."
pub fn parse_mdw(text: &str) -> Result<Vec<u32>, String> {
    let mut words = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.contains(':') == false {
            continue;
        }
        let (addr_part, rest) = line.split_once(':').ok_or_else(|| format!("bad mdw line: {line}"))?;
        if !addr_part.trim().starts_with("0x") && addr_part.trim().parse::<u64>().is_err() {
            continue;
        }
        for tok in rest.split_whitespace() {
            let tok = tok.trim_start_matches("0x").trim_start_matches("0X");
            match u32::from_str_radix(tok, 16) {
                Ok(w) => words.push(w),
                Err(_) => return Err(format!("bad word in mdw line: {line}")),
            }
        }
    }
    Ok(words)
}

/// Kilobytes from a FLASH_SIZE option-byte word, rejecting the all-ones /
/// all-zeros a bus fault or a sleeping chip returns.
pub fn flash_size_kb(word: u32) -> Option<u64> {
    match (word & 0xFFFF) as u64 {
        kb @ 1..=2048 => Some(kb),
        _ => None,
    }
}

/// Parse `targets` output (openocd 0.10+, format verified against 0.12):
///
/// ```text
///     TargetName         Type       Endian     TapName            State
///   --  ------------------ ---------- ---------- ------------------ ----------
///    0* dummy.cpu         testee     little     dummy.tap          unknown
/// ```
///
/// The `*` attached to the index marks the current target; the state may be
/// multiple words (e.g. "examine pending").
pub fn parse_targets(text: &str) -> Result<Vec<TargetState>, String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let toks: Vec<&str> = line.split_whitespace().collect();
        if toks.len() < 6 {
            continue;
        }
        // Header ("TargetName ...") and separator ("-- ----...") rows.
        if toks[0] == "TargetName" || toks[0] == "--" {
            continue;
        }
        let (index, current) = match toks[0].strip_suffix('*') {
            Some(n) => match n.parse::<u32>() {
                Ok(i) => (i, true),
                Err(_) => continue,
            },
            None => match toks[0].parse::<u32>() {
                Ok(i) => (i, false),
                Err(_) => continue,
            },
        };
        out.push(TargetState {
            index,
            current,
            name: toks[1].to_string(),
            target_type: toks[2].to_string(),
            // Tap name doubles as the description shown in the UI.
            description: toks[4].to_string(),
            state: toks[5..].join(" "),
        });
    }
    Ok(out)
}

/// Parse `flash banks` output lines like:
///   "#0 : stm32f1x.flash at 0x08000000, size 0x00010000, buswidth 0, chipwidth 0"
pub fn parse_flash_banks(text: &str) -> Result<Vec<FlashBank>, String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with('#') {
            continue;
        }
        let rest = line.trim_start_matches(|c: char| !c.is_ascii_digit());
        let (idx, rest) = rest.split_once(':').ok_or_else(|| format!("bad flash banks line: {line}"))?;
        let index = idx.trim().parse::<u32>().map_err(|_| format!("bad bank index: {line}"))?;
        let rest = rest.trim();
        let name = rest.split(" at ").next().unwrap_or("").trim().to_string();
        let base = rest
            .split(" at ")
            .nth(1)
            .and_then(|s| s.split(',').next())
            .and_then(|s| u64::from_str_radix(s.trim().trim_start_matches("0x"), 16).ok())
            .unwrap_or(0);
        let size = rest
            .split("size ")
            .nth(1)
            .and_then(|s| s.split(',').next())
            .and_then(|s| u64::from_str_radix(s.trim().trim_start_matches("0x"), 16).ok())
            .unwrap_or(0);
        out.push(FlashBank { index, name, base, size, inferred: false });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mdw_without_prefix() {
        let t = "0x08000000: ffffffff ffffffff ffffffff ffffffff\n0x08000010: 12345678 9abcdef0";
        let w = parse_mdw(t).unwrap();
        assert_eq!(w, vec![0xffffffff; 4].into_iter().chain([0x12345678, 0x9abcdef0]).collect::<Vec<_>>());
    }

    #[test]
    fn mdw_with_prefix() {
        let t = "0x08000000: 0x20005000 0x080001A9";
        let w = parse_mdw(t).unwrap();
        assert_eq!(w, vec![0x20005000, 0x080001a9]);
    }

    #[test]
    fn mdw_ignores_non_address_lines() {
        // Non-address lines (e.g. error text) are skipped; caller checks has_error().
        let t = "memory read failed: DP fault\nError: fault";
        let w = parse_mdw(t).unwrap();
        assert!(w.is_empty());
    }

    #[test]
    fn targets_openocd_012() {
        let t = concat!(
            "    TargetName         Type       Endian     TapName            State\n",
            "--  ------------------ ---------- ---------- ------------------ ----------\n",
            " 0* dummy.cpu         testee     little     dummy.tap          unknown\n",
            " 1  aux.cpu            cortex_m   little     aux.cpu            halted",
        );
        let ts = parse_targets(t).unwrap();
        assert_eq!(ts.len(), 2);
        assert!(ts[0].current);
        assert_eq!(ts[0].index, 0);
        assert_eq!(ts[0].name, "dummy.cpu");
        assert_eq!(ts[0].target_type, "testee");
        assert_eq!(ts[0].state, "unknown");
        assert_eq!(ts[0].description, "dummy.tap");
        assert!(!ts[1].current);
        assert_eq!(ts[1].name, "aux.cpu");
        assert_eq!(ts[1].state, "halted");
    }

    #[test]
    fn targets_multiword_state() {
        // Row shape observed from the dummy target during protocol verification.
        let t = " 0* dummy.cpu testee little dummy.tap examine pending";
        let ts = parse_targets(t).unwrap();
        assert!(ts[0].current);
        assert_eq!(ts[0].state, "examine pending");
    }

    #[test]
    fn flash_banks_line() {
        let t = "#0 : stm32f1x.flash at 0x08000000, size 0x00010000, buswidth 0, chipwidth 0";
        let b = parse_flash_banks(t).unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].name, "stm32f1x.flash");
        assert_eq!(b[0].base, 0x08000000);
        assert_eq!(b[0].size, 0x10000);
        assert!(!b[0].inferred);
    }

    #[test]
    fn flash_banks_unprobed_size_is_zero() {
        // Observed shape on the bench: driver name in parentheses, size still 0
        // because examine-end failed before the bank was probed.
        let t = "#0 : stm32f0x.flash (stm32f1x) at 0x08000000, size 0x00000000, buswidth 0, chipwidth 0";
        let b = parse_flash_banks(t).unwrap();
        assert_eq!(b[0].size, 0);
    }

    #[test]
    fn flash_size_kb_accepts_real_capacities() {
        assert_eq!(flash_size_kb(0x0000_0020), Some(32)); // the bench part reports 32 KB
        assert_eq!(flash_size_kb(0x1234_0100), Some(256));
        assert_eq!(flash_size_kb(0x0000_0800), Some(2048)); // largest shipping STM32 flash
    }

    #[test]
    fn flash_size_kb_rejects_bus_fault_reads() {
        assert_eq!(flash_size_kb(0xFFFF_FFFF), None);
        assert_eq!(flash_size_kb(0), None);
        assert_eq!(flash_size_kb(0x0001_0000), None); // nothing ships with 64 MB of flash
    }
}
