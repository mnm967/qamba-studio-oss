//! What this machine is, and whether it can render anything locally.
//!
//! WHY SHELLING OUT IS THE RIGHT CALL HERE. The alternatives are an NVML
//! binding (NVIDIA-only, a build dependency on the CUDA toolkit, and it links
//! against a driver library that may not exist) or a `wgpu` adapter enumeration
//! (pulls a graphics stack into a process that only wants a number, and reports
//! adapter limits rather than physical VRAM). `nvidia-smi` and
//! `system_profiler` are the interfaces those platforms actually document for
//! this question, they cost one process spawn at startup, and when they are
//! absent their absence IS the answer.
//!
//! EVERY PROBE FAILS SOFT. A machine that reports no GPU still gets a profile
//! with its RAM and disk filled in — the setup screen's job is then to say
//! "cloud mode", which it cannot do if the whole call errored.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use sysinfo::{Disks, System};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuInfo {
    pub name: String,
    /// "nvidia" | "apple" | "amd" | "intel" | "unknown"
    pub vendor: String,
    pub vram_mb: u64,
    /// Apple Silicon shares one pool with the CPU. The distinction decides
    /// whether a 21GB checkpoint is a plan or a swap storm, so it travels with
    /// the number rather than being re-derived from the vendor string later.
    pub unified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareProfile {
    pub os: String,
    pub arch: String,
    pub cpu: String,
    pub cores: usize,
    pub ram_mb: u64,
    pub free_disk_mb: u64,
    pub gpus: Vec<GpuInfo>,
    pub comfy_paths: Vec<String>,
}

/// Keep a child process from flashing a console window on Windows.
///
/// The release binary is built with windows_subsystem = "windows", so it has
/// no console of its own — which means every console-subsystem child it starts
/// (tar, python, powershell, nvidia-smi) is handed a BRAND NEW one, and that
/// one is visible. A hardware probe that flickers a black box over the setup
/// screen reads as a crash; ComfyUI is the worse case, because it is
/// long-lived and its console would then sit on screen for the life of the
/// engine. CREATE_NO_WINDOW is the documented flag for exactly this. A no-op
/// on every other platform, so call sites do not branch.
#[cfg(target_os = "windows")]
pub fn no_window(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000) // CREATE_NO_WINDOW
}
#[cfg(not(target_os = "windows"))]
pub fn no_window(cmd: &mut Command) -> &mut Command {
    cmd
}

/// Run a command and return stdout, or None if it is not installed / failed.
fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new(cmd);
    c.args(args);
    let out = no_window(&mut c).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// NVIDIA, on any platform that has the driver installed.
fn nvidia_gpus() -> Vec<GpuInfo> {
    let Some(out) = run(
        "nvidia-smi",
        &["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
    ) else {
        return vec![];
    };
    out.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, ',');
            let name = parts.next()?.trim().to_string();
            let mb: u64 = parts.next()?.trim().parse().ok()?;
            if name.is_empty() {
                return None;
            }
            Some(GpuInfo { name, vendor: "nvidia".into(), vram_mb: mb, unified: false })
        })
        .collect()
}

/// Apple Silicon and Intel Macs.
///
/// `system_profiler` reports no VRAM figure for an Apple GPU, because there
/// isn't one to report — the GPU addresses system memory. Substituting total
/// RAM is therefore the truthful answer to "how much can a model use", and
/// `unified: true` is what stops a caller reading it as dedicated VRAM.
#[cfg(target_os = "macos")]
fn platform_gpus(total_ram_mb: u64) -> Vec<GpuInfo> {
    let Some(json) = run("system_profiler", &["SPDisplaysDataType", "-json"]) else {
        return vec![];
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) else {
        return vec![];
    };
    let mut out = vec![];
    for item in v["SPDisplaysDataType"].as_array().unwrap_or(&vec![]) {
        let name = item["sppci_model"].as_str().unwrap_or("Apple GPU").to_string();
        let apple = item["spdisplays_vendor"]
            .as_str()
            .map(|s| s.contains("apple") || s.contains("Apple"))
            .unwrap_or(name.starts_with("Apple"));
        // an eGPU or an Intel Mac's discrete card DOES report its own VRAM
        let dedicated = item["spdisplays_vram_shared"]
            .as_str()
            .or_else(|| item["spdisplays_vram"].as_str())
            .and_then(parse_mb);
        out.push(GpuInfo {
            vendor: if apple { "apple".into() } else if name.contains("AMD") { "amd".into() }
                    else if name.contains("Intel") { "intel".into() } else { "unknown".into() },
            vram_mb: if apple { total_ram_mb } else { dedicated.unwrap_or(0) },
            unified: apple,
            name,
        });
    }
    out
}

/// "16 GB" / "8192 MB" → megabytes.
#[cfg(target_os = "macos")]
fn parse_mb(s: &str) -> Option<u64> {
    let s = s.trim();
    let num: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    let n: u64 = num.parse().ok()?;
    Some(if s.to_lowercase().contains("gb") { n * 1024 } else { n })
}

#[cfg(target_os = "windows")]
fn platform_gpus(_total_ram_mb: u64) -> Vec<GpuInfo> {
    // WMIC IS GONE, AND ITS ABSENCE LOOKED EXACTLY LIKE A MACHINE WITH NO GPU.
    // It was deprecated in Windows 10 21H1 and is no longer present on current
    // Windows 11 — verified missing on build 26200, where this returned None
    // and the setup screen offered cloud mode to a laptop that has a card.
    // The failure is silent by construction: every probe in this file fails
    // soft, so an absent TOOL and an absent CARD produce the same empty list.
    // CIM is the supported replacement and ships with Windows PowerShell on
    // every build, so it is asked first and wmic is kept only for Windows 10.
    //
    // AdapterRAM is a 32-bit field and wraps above 4GB, so it is read only as
    // a last resort and only to prove a card EXISTS — the VRAM figure that
    // matters comes from nvidia-smi, which ran first.
    let rows: Vec<(String, u64)> = if let Some(out) = run(
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            r#"Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }"#,
        ],
    ) {
        out.lines()
            .filter_map(|line| {
                // rsplit so a card whose name contains the delimiter still parses
                let (name, ram) = line.rsplit_once('|')?;
                let name = name.trim();
                if name.is_empty() { return None; }
                Some((name.to_string(), ram.trim().parse().unwrap_or(0)))
            })
            .collect()
    } else {
        let Some(out) = run("wmic", &["path", "win32_VideoController", "get", "name,AdapterRAM", "/format:csv"]) else {
            return vec![];
        };
        out.lines()
            .skip(1)
            .filter_map(|line| {
                let cols: Vec<&str> = line.split(',').collect();
                if cols.len() < 3 { return None; }
                let name = cols[2].trim();
                if name.is_empty() { return None; }
                Some((name.to_string(), cols[1].trim().parse().unwrap_or(0)))
            })
            .collect()
    };

    rows.into_iter()
        .map(|(name, bytes)| {
            let vendor = if name.contains("NVIDIA") { "nvidia" }
                else if name.contains("AMD") || name.contains("Radeon") { "amd" }
                else if name.contains("Intel") { "intel" } else { "unknown" };
            GpuInfo { name, vendor: vendor.into(), vram_mb: bytes / 1_048_576, unified: false }
        })
        .collect()
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn platform_gpus(_total_ram_mb: u64) -> Vec<GpuInfo> {
    let Some(out) = run("lspci", &[]) else { return vec![] };
    out.lines()
        .filter(|l| l.contains("VGA compatible controller") || l.contains("3D controller"))
        .filter_map(|l| {
            let name = l.split(": ").nth(1)?.trim().to_string();
            let vendor = if name.contains("NVIDIA") { "nvidia" }
                else if name.contains("AMD") || name.contains("ATI") { "amd" }
                else if name.contains("Intel") { "intel" } else { "unknown" };
            // no VRAM figure from lspci; nvidia-smi already covered the case
            // where one is available
            Some(GpuInfo { name, vendor: vendor.into(), vram_mb: 0, unified: false })
        })
        .collect()
}

/// Standard ComfyUI locations, so the setup screen can offer "link the one you
/// already have" instead of asking for a path.
///
/// A directory only counts if it looks like a real install — `main.py` beside a
/// `comfy/` package. An empty `~/ComfyUI` left over from an abandoned clone
/// would otherwise be offered as an engine and fail at connect time.
fn find_comfy_installs() -> Vec<String> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut candidates: Vec<PathBuf> = vec![
        home.join("ComfyUI"),
        home.join("comfy"),
        home.join("comfyui"),
        home.join("Documents/ComfyUI"),
        home.join("Documents/comfyui"),
        home.join("Desktop/ComfyUI"),
        // Pinokio keeps each app in its own directory
        home.join("pinokio/api/comfy.git/app"),
        home.join("pinokio/api/comfyui.git/app"),
        // StabilityMatrix
        home.join("Data/Packages/ComfyUI"),
        home.join(".local/share/StabilityMatrix/Packages/ComfyUI"),
    ];
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/Applications/ComfyUI.app/Contents/Resources/ComfyUI"));
        candidates.push(home.join("Library/Application Support/ComfyUI"));
    }
    #[cfg(target_os = "windows")]
    {
        candidates.push(PathBuf::from("C:\\ComfyUI"));
        candidates.push(PathBuf::from("C:\\ComfyUI_windows_portable\\ComfyUI"));
        candidates.push(home.join("AppData/Local/Programs/@comfyorgcomfyui-electron/resources/ComfyUI"));
    }

    candidates
        .into_iter()
        .filter(|p| p.join("main.py").is_file() && p.join("comfy").is_dir())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

pub fn detect() -> HardwareProfile {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();

    let ram_mb = sys.total_memory() / 1_048_576;

    // free space where the engine and weights will actually live, not on "/"
    let target = dirs::data_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default());
    let disks = Disks::new_with_refreshed_list();
    let free_disk_mb = disks
        .iter()
        .filter(|d| target.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())   // the most specific mount wins
        .or_else(|| disks.iter().next())
        .map(|d| d.available_space() / 1_048_576)
        .unwrap_or(0);

    let mut gpus = nvidia_gpus();
    if gpus.is_empty() {
        gpus = platform_gpus(ram_mb);
    }

    HardwareProfile {
        os: format!("{} {}", System::name().unwrap_or_default(),
                    System::os_version().unwrap_or_default()).trim().to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpu: sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
        cores: sys.cpus().len(),
        ram_mb,
        free_disk_mb,
        gpus,
        comfy_paths: find_comfy_installs(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_always_returns_a_profile() {
        // The setup screen's whole job on a GPU-less machine is to say "use
        // cloud mode", which it cannot do if the probe errored instead of
        // reporting an empty GPU list.
        let p = detect();
        // Printed because this is a probe: when it fails on someone's machine,
        // what it saw is the first thing you need. `cargo test -- --nocapture`.
        eprintln!("{}", serde_json::to_string_pretty(&p).unwrap_or_default());
        assert!(p.ram_mb > 0, "no memory reported");
        assert!(p.cores > 0, "no cores reported");
        assert!(!p.arch.is_empty());
    }

    #[test]
    fn a_comfy_path_is_a_real_install_or_absent() {
        for p in detect().comfy_paths {
            let path = PathBuf::from(&p);
            assert!(path.join("main.py").is_file(), "{p} was offered without a main.py");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn apple_silicon_reports_unified_memory_as_its_budget() {
        let p = detect();
        if let Some(g) = p.gpus.iter().find(|g| g.vendor == "apple") {
            assert!(g.unified, "an Apple GPU must be flagged unified");
            assert_eq!(g.vram_mb, p.ram_mb, "unified budget is the machine's RAM");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vram_strings_parse() {
        assert_eq!(parse_mb("16 GB"), Some(16384));
        assert_eq!(parse_mb("8192 MB"), Some(8192));
        assert_eq!(parse_mb("garbage"), None);
    }
}
