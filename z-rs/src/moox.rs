use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
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
    let _days_since_epoch = secs / 86400;
    // Just show relative
    format!("{}w ago", diff / 604800)
}

pub fn moox_history(id: &str) -> String {
    match Command::new("moox").args(["history", "--vt", id]).output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => String::new(),
    }
}

/// Strip ANSI escape sequences, OSC, charset switches, CR, and control chars.
/// Keeps printable text, newlines, and tabs.
pub fn strip_ansi(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut result = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            // ESC
            i += 1;
            if i >= bytes.len() {
                break;
            }
            match bytes[i] {
                b'[' => {
                    // CSI sequence — skip all (including SGR)
                    i += 1;
                    while i < bytes.len() && (bytes[i] < 0x40 || bytes[i] > 0x7e) {
                        i += 1;
                    }
                    if i < bytes.len() {
                        i += 1;
                    } // skip final byte
                }
                b']' => {
                    // OSC — skip until BEL or ST
                    i += 1;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                b'(' | b')' => {
                    // Charset designation — skip next byte
                    i += 1;
                    if i < bytes.len() {
                        i += 1;
                    }
                }
                _ => {
                    i += 1;
                }
            }
        } else if b == b'\r' {
            i += 1;
        } else if b < 0x20 && b != b'\n' && b != b'\t' {
            // Strip other control chars
            i += 1;
        } else {
            // Printable or newline/tab — keep
            // Handle UTF-8 properly
            let ch_len = if b < 0x80 {
                1
            } else if b < 0xe0 {
                2
            } else if b < 0xf0 {
                3
            } else {
                4
            };
            let end = (i + ch_len).min(bytes.len());
            if let Ok(ch) = std::str::from_utf8(&bytes[i..end]) {
                result.push_str(ch);
            }
            i = end;
        }
    }
    result
}

pub fn ansi_lines(s: &str) -> Vec<Line<'static>> {
    let bytes = s.as_bytes();
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut current = String::new();
    let mut style = Style::default();
    let mut i = 0;

    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            i += 1;
            if i >= bytes.len() {
                break;
            }
            match bytes[i] {
                b'[' => {
                    i += 1;
                    let start = i;
                    while i < bytes.len() && (bytes[i] < 0x40 || bytes[i] > 0x7e) {
                        i += 1;
                    }
                    if i >= bytes.len() {
                        break;
                    }
                    let final_byte = bytes[i];
                    let params = std::str::from_utf8(&bytes[start..i]).unwrap_or("");
                    i += 1;
                    if final_byte == b'm' {
                        flush_span(&mut spans, &mut current, style);
                        apply_sgr(&mut style, params);
                    }
                }
                b']' => {
                    i += 1;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                b'(' | b')' => {
                    i += 1;
                    if i < bytes.len() {
                        i += 1;
                    }
                }
                _ => {
                    i += 1;
                }
            }
        } else if b == b'\n' {
            flush_span(&mut spans, &mut current, style);
            lines.push(Line::from(std::mem::take(&mut spans)));
            i += 1;
        } else if b == b'\r' {
            i += 1;
        } else if b < 0x20 && b != b'\t' {
            i += 1;
        } else {
            let ch_len = if b < 0x80 {
                1
            } else if b < 0xe0 {
                2
            } else if b < 0xf0 {
                3
            } else {
                4
            };
            let end = (i + ch_len).min(bytes.len());
            if let Ok(ch) = std::str::from_utf8(&bytes[i..end]) {
                current.push_str(ch);
            }
            i = end;
        }
    }

    flush_span(&mut spans, &mut current, style);
    if !spans.is_empty() || s.ends_with('\n') || lines.is_empty() {
        lines.push(Line::from(spans));
    }

    lines
}

fn flush_span(spans: &mut Vec<Span<'static>>, current: &mut String, style: Style) {
    if current.is_empty() {
        return;
    }
    spans.push(Span::styled(std::mem::take(current), style));
}

fn apply_sgr(style: &mut Style, params: &str) {
    let codes: Vec<u16> = if params.is_empty() {
        vec![0]
    } else {
        params
            .split(';')
            .map(|part| {
                if part.is_empty() {
                    0
                } else {
                    part.parse::<u16>().unwrap_or(0)
                }
            })
            .collect()
    };

    let mut i = 0;
    while i < codes.len() {
        match codes[i] {
            0 => *style = Style::default(),
            1 => *style = style.add_modifier(Modifier::BOLD),
            2 => *style = style.add_modifier(Modifier::DIM),
            3 => *style = style.add_modifier(Modifier::ITALIC),
            4 => *style = style.add_modifier(Modifier::UNDERLINED),
            22 => *style = style.remove_modifier(Modifier::BOLD | Modifier::DIM),
            23 => *style = style.remove_modifier(Modifier::ITALIC),
            24 => *style = style.remove_modifier(Modifier::UNDERLINED),
            30..=37 => *style = style.fg(ansi_basic_color(codes[i] - 30, false)),
            39 => *style = style.fg(Color::Reset),
            40..=47 => *style = style.bg(ansi_basic_color(codes[i] - 40, false)),
            49 => *style = style.bg(Color::Reset),
            90..=97 => *style = style.fg(ansi_basic_color(codes[i] - 90, true)),
            100..=107 => *style = style.bg(ansi_basic_color(codes[i] - 100, true)),
            38 | 48 => {
                let is_fg = codes[i] == 38;
                if let Some((color, consumed)) = parse_extended_color(&codes[i + 1..]) {
                    *style = if is_fg {
                        style.fg(color)
                    } else {
                        style.bg(color)
                    };
                    i += consumed;
                }
            }
            _ => {}
        }
        i += 1;
    }
}

fn parse_extended_color(codes: &[u16]) -> Option<(Color, usize)> {
    match codes {
        [5, index, ..] => Some((ansi_256_color(*index as u8), 2)),
        [2, r, g, b, ..] => Some((Color::Rgb(*r as u8, *g as u8, *b as u8), 4)),
        _ => None,
    }
}

fn ansi_basic_color(index: u16, bright: bool) -> Color {
    match (index, bright) {
        (0, false) => Color::Black,
        (1, false) => Color::Red,
        (2, false) => Color::Green,
        (3, false) => Color::Yellow,
        (4, false) => Color::Blue,
        (5, false) => Color::Magenta,
        (6, false) => Color::Cyan,
        (7, false) => Color::Gray,
        (0, true) => Color::DarkGray,
        (1, true) => Color::LightRed,
        (2, true) => Color::LightGreen,
        (3, true) => Color::LightYellow,
        (4, true) => Color::LightBlue,
        (5, true) => Color::LightMagenta,
        (6, true) => Color::LightCyan,
        (7, true) => Color::White,
        _ => Color::Reset,
    }
}

fn ansi_256_color(index: u8) -> Color {
    match index {
        0..=15 => {
            let bright = index >= 8;
            ansi_basic_color((index % 8) as u16, bright)
        }
        16..=231 => {
            let idx = index - 16;
            let r = idx / 36;
            let g = (idx % 36) / 6;
            let b = idx % 6;
            let component = |value: u8| if value == 0 { 0 } else { 55 + value * 40 };
            Color::Rgb(component(r), component(g), component(b))
        }
        232..=255 => {
            let shade = 8 + (index - 232) * 10;
            Color::Rgb(shade, shade, shade)
        }
    }
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
    let _ = Command::new("moox").args(["kill", id]).output();
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
            "@",
            "launch",
            "--env",
            "SHLVL=0",
            "--cwd",
            cwd,
            &shell,
            "-lc",
            &format!("{}{}", pane_title, moox_cmd),
        ])
        .output();
}

pub fn kitty_attach_moox(id: &str, window_title: Option<&str>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let title_cmd = window_title
        .map(|t| format!("kitty @ set-window-title '{}'; ", t.replace('\'', "'\\''")))
        .unwrap_or_default();

    let _ = Command::new("kitty")
        .args([
            "@",
            "launch",
            "--env",
            "SHLVL=0",
            &shell,
            "-lc",
            &format!("{}moox attach {}", title_cmd, id),
        ])
        .output();
}

pub fn kitty_attach_moox_in_new_tab(id: &str, tab_title: &str, window_title: Option<&str>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let title_cmd = window_title
        .map(|t| format!("kitty @ set-window-title '{}'; ", t.replace('\'', "'\\''")))
        .unwrap_or_default();

    let _ = Command::new("kitty")
        .args([
            "@",
            "launch",
            "--type",
            "tab",
            "--tab-title",
            tab_title,
            "--env",
            "SHLVL=0",
            &shell,
            "-lc",
            &format!("{}moox attach {}", title_cmd, id),
        ])
        .output();
}

pub fn kitty_attach_moox_in_tab(id: &str, tab_match: &str, window_title: Option<&str>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let title_cmd = window_title
        .map(|t| format!("kitty @ set-window-title '{}'; ", t.replace('\'', "'\\''")))
        .unwrap_or_default();

    let _ = Command::new("kitty")
        .args([
            "@",
            "launch",
            "--match",
            tab_match,
            "--env",
            "SHLVL=0",
            &shell,
            "-lc",
            &format!("{}moox attach {}", title_cmd, id),
        ])
        .output();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub fn running_pane_icon(s: &MooxSession) -> &'static str {
    if s.clients == 0 {
        "\u{f444}"
    } else {
        "\u{f489}"
    }
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
