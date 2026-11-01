//! Locate OpenOCD script directories and enumerate interface/target configs.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize)]
pub struct CfgEntry {
    /// File name, e.g. "stlink.cfg"
    pub name: String,
    /// Absolute path for `-f`
    pub path: String,
    /// Which script dir it came from
    pub dir: String,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
pub struct ScriptLists {
    pub interfaces: Vec<CfgEntry>,
    pub targets: Vec<CfgEntry>,
    /// All detected script dirs
    pub dirs: Vec<String>,
}

/// Resolve a binary name via PATH (no external crates).
fn resolve_binary(binary: &str) -> Option<PathBuf> {
    let p = Path::new(binary);
    if p.is_absolute() || binary.contains('/') || binary.contains('\\') {
        return Some(p.to_path_buf());
    }
    let path_var = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        ["", ".exe"].iter().map(|s| s.to_string()).collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path_var) {
        for ext in &exts {
            let candidate = dir.join(format!("{binary}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Probe well-known locations for the OpenOCD scripts directory.
pub fn find_script_dirs(binary: &str) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(dir) = std::env::var("OPENOCD_SCRIPTS") {
        candidates.push(PathBuf::from(dir));
    }

    // Relative to the binary: <bin>/../share/openocd/scripts
    if let Some(bin) = resolve_binary(binary) {
        if let Some(parent) = bin.parent().and_then(|p| p.parent()) {
            candidates.push(parent.join("share/openocd/scripts"));
        }
    }

    for dir in [
        "/usr/share/openocd/scripts",
        "/usr/local/share/openocd/scripts",
        "/opt/homebrew/share/openocd/scripts",
        "C:\\Program Files\\OpenOCD\\share\\openocd\\scripts",
        "C:\\Program Files (x86)\\OpenOCD\\share\\openocd\\scripts",
    ] {
        candidates.push(PathBuf::from(dir));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Programs/OpenOCD/share/openocd/scripts"));
    }

    let mut dirs = Vec::new();
    for c in candidates {
        if c.join("target").is_dir() && !dirs.contains(&c) {
            dirs.push(c);
        }
    }
    dirs
}

fn list_subdir(dir: &Path, sub: &str) -> Vec<CfgEntry> {
    let mut out = Vec::new();
    let dir_str = dir.to_string_lossy().to_string();
    if let Ok(rd) = std::fs::read_dir(dir.join(sub)) {
        for e in rd.flatten() {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) == Some("cfg") {
                out.push(CfgEntry {
                    name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                    path: path.to_string_lossy().to_string(),
                    dir: dir_str.clone(),
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Enumerate interface/ and target/ configs across all detected script dirs.
pub fn list_scripts(binary: &str) -> ScriptLists {
    let dirs = find_script_dirs(binary);
    let mut lists = ScriptLists { dirs: dirs.iter().map(|d| d.to_string_lossy().to_string()).collect(), ..Default::default() };
    for d in &dirs {
        lists.interfaces.extend(list_subdir(d, "interface"));
        lists.targets.extend(list_subdir(d, "target"));
    }
    lists
}
