use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct MooxSession {
    pub id: String,
    pub tab: String,
    pub pane: String,
    pub created: u64,
    pub clients: u32,
}

#[derive(Deserialize)]
struct MooxListEntry {
    id: Option<String>,
    tab: Option<String>,
    pane: Option<String>,
    created: Option<u64>,
    clients: Option<u32>,
}

// ---------------------------------------------------------------------------
// Session listing
// ---------------------------------------------------------------------------

pub fn list_sessions() -> Vec<MooxSession> {
    let output = match Command::new("moox").args(["list", "-j"]).output() {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };

    let entries: Vec<MooxListEntry> = match serde_json::from_slice(&output) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    entries
        .into_iter()
        .filter_map(|e| {
            let tab = e.tab?;
            if tab.is_empty() {
                return None;
            }
            Some(MooxSession {
                id: e.id.unwrap_or_default(),
                tab,
                pane: e.pane.unwrap_or_default(),
                created: e.created.unwrap_or(0),
                clients: e.clients.unwrap_or(0),
            })
        })
        .collect()
}

pub fn unique_tabs(sessions: &[MooxSession]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut tabs = Vec::new();
    for s in sessions {
        if seen.insert(s.tab.clone()) {
            tabs.push(s.tab.clone());
        }
    }
    tabs.sort();
    tabs
}

pub fn panes_for_tab<'a>(sessions: &'a [MooxSession], tab: &str) -> Vec<&'a MooxSession> {
    sessions.iter().filter(|s| s.tab == tab).collect()
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

pub fn time_ago(created: u64) -> String {
    if created == 0 {
        return String::new();
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if now < created {
        return "just now".to_string();
    }
    let diff = now - created;
    if diff < 60 {
        return format!("{}s ago", diff);
    }
    if diff < 3600 {
        return format!("{}m ago", diff / 60);
    }
    if diff < 86400 {
        return format!("{}h ago", diff / 3600);
    }
    if diff < 604800 {
        return format!("{}d ago", diff / 86400);
    }
    // Older than a week: show date
    let secs = created as i64;
    // Simple date formatting without chrono
    let days_since_epoch = secs / 86400;
    // Just show relative
    format!("{}w ago", diff / 604800)
}

// ---------------------------------------------------------------------------
// Moox commands
// ---------------------------------------------------------------------------

pub fn moox_attach(
    id: Option<&str>,
    command: Option<&str>,
    dir: Option<&str>,
    vars: Option<&HashMap<String, String>>,
) -> i32 {
    let mut args: Vec<String> = vec!["attach".to_string()];

    if let Some(vars) = vars {
        for (k, v) in vars {
            args.push("--var".to_string());
            args.push(format!("{}={}", k, v));
        }
    }

    if let Some(id) = id {
        args.push(id.to_string());
    } else {
        args.push("-".to_string());
    }

    if let Some(cmd) = command {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        args.push(shell);
        args.push("-c".to_string());
        args.push(cmd.to_string());
    } else if id.is_none() {
        // New session, no command — don't pass anything, moox uses login shell
    }

    let mut cmd = Command::new("moox");
    cmd.args(&args);
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }

    match cmd.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(_) => 1,
    }
}

pub fn moox_kill(id: &str) {
    let _ = Command::new("moox")
        .args(["kill", id])
        .output();
}

pub fn moox_set_vars(id: &str, vars: &HashMap<String, String>) {
    let mut args = vec!["vars".to_string(), id.to_string()];
    for (k, v) in vars {
        args.push("--var".to_string());
        args.push(format!("{}={}", k, v));
    }
    let _ = Command::new("moox").args(&args).output();
}

// ---------------------------------------------------------------------------
// Kitty commands
// ---------------------------------------------------------------------------

pub fn get_kitty_tab_title() -> Option<String> {
    let output = Command::new("kitty")
        .args(["@", "ls", "--self"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let data: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let tab = data.get(0)?.get("tabs")?.get(0)?;
    let overridden = tab.get("title_overridden")?.as_bool()?;
    if !overridden {
        return None;
    }
    tab.get("title")?.as_str().map(|s| s.to_string())
}

pub fn set_kitty_tab_title(title: &str) {
    let _ = Command::new("kitty")
        .args(["@", "set-tab-title", title])
        .output();
}

pub fn set_kitty_window_title(title: &str) {
    let _ = Command::new("kitty")
        .args(["@", "set-window-title", title])
        .output();
}

pub fn kitty_launch_moox(
    command: Option<&str>,
    dir: Option<&str>,
    vars: Option<&HashMap<String, String>>,
) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let var_args = vars
        .map(|v| {
            v.iter()
                .map(|(k, v)| format!("--var {}={}", k, v))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();

    let cmd_part = match command {
        Some(cmd) => format!("- {} -c '{}'", shell, cmd.replace('\'', "'\\''")),
        None => "-".to_string(),
    };

    let pane_title = vars
        .and_then(|v| v.get("pane"))
        .map(|p| {
            format!(
                "kitty @ set-window-title '{}'; ",
                p.replace('_', " ").replace('\'', "'\\''")
            )
        })
        .unwrap_or_default();

    let moox_cmd = format!("moox attach {} {}", var_args, cmd_part)
        .trim()
        .replace("  ", " ");

    let cwd = dir.unwrap_or(".");

    let _ = Command::new("kitty")
        .args([
            "@", "launch",
            "--env", "SHLVL=0",
            "--cwd", cwd,
            &shell, "-lc", &format!("{}{}", pane_title, moox_cmd),
        ])
        .output();
}

pub fn kitty_attach_moox(id: &str, window_title: Option<&str>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let title_cmd = window_title
        .map(|t| {
            format!(
                "kitty @ set-window-title '{}'; ",
                t.replace('\'', "'\\''")
            )
        })
        .unwrap_or_default();

    let _ = Command::new("kitty")
        .args([
            "@", "launch",
            "--env", "SHLVL=0",
            &shell, "-lc", &format!("{}moox attach {}", title_cmd, id),
        ])
        .output();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub fn running_pane_icon(s: &MooxSession) -> &'static str {
    if s.clients == 0 { "\u{f444}" } else { "\u{f489}" }
}

pub fn running_pane_suffix(s: &MooxSession) -> String {
    let mut parts = Vec::new();
    let ago = time_ago(s.created);
    if !ago.is_empty() {
        parts.push(ago);
    }
    if s.clients == 0 {
        parts.push("[disconnected]".to_string());
    } else if s.clients > 1 {
        parts.push(format!("[{} attached]", s.clients));
    }
    parts.join(" ")
}
