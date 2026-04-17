use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Default)]
pub struct StyleSpec {
    pub fg: Option<String>,
    pub bg: Option<String>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub dim: Option<bool>,
    pub strikethrough: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct Style {
    pub fg: Option<String>,
    pub bg: Option<String>,
    pub bold: bool,
    pub italic: bool,
    pub dim: bool,
}

#[derive(Debug, Clone)]
pub struct Colors {
    pub tab: Style,
    pub pane: Style,
    pub new: Style,
    pub running: Style,
    pub selection: Style,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct DefaultPane {
    pub name: Option<String>,
    pub cmd: Option<String>,
    pub dir: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub default: DefaultPane,
    pub colors: Colors,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LayoutPane {
    #[serde(default)]
    pub name: String,
    pub display: Option<String>,
    pub cmd: Option<String>,
    pub dir: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LayoutTab {
    #[serde(default)]
    pub name: String,
    pub dir: Option<String>,
    #[serde(default)]
    pub panes: Vec<LayoutPane>,
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

pub fn config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        PathBuf::from(xdg).join("z")
    } else {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .join(".config")
            .join("z")
    }
}

fn config_path() -> PathBuf {
    config_dir().join("config.yaml")
}

fn layouts_path() -> PathBuf {
    config_dir().join("layouts.yaml")
}

fn layouts_d_dir() -> PathBuf {
    config_dir().join("layouts.d")
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: &str = r#"# z configuration

# Default pane settings for "New Shell" menu items
#   name: kitty window title and moox pane var (omit to not set)
#   cmd:  command to run (omit for login shell)
#   dir:  "ask" to prompt, or a fixed path (omit for cwd)
default:
  name: Shell
"#;

pub fn ensure_config_dir() {
    let dir = config_dir();
    let _ = fs::create_dir_all(&dir);
    let ld = layouts_d_dir();
    let _ = fs::create_dir_all(&ld);
    let cp = config_path();
    if !cp.exists() {
        let _ = fs::write(&cp, DEFAULT_CONFIG);
    }
}

// ---------------------------------------------------------------------------
// Color resolution
// ---------------------------------------------------------------------------

fn normalize_color(color: &str) -> String {
    // Expand short hex
    if color.starts_with('#') && color.len() == 4 {
        let chars: Vec<char> = color[1..].chars().collect();
        return format!(
            "#{}{}{}{}{}{}",
            chars[0], chars[0], chars[1], chars[1], chars[2], chars[2]
        );
    }
    // Map user-facing names to ratatui-compatible names
    match color {
        "purple" => "magenta".to_string(),
        "bright purple" => "bright magenta".to_string(),
        _ => color.to_string(),
    }
}

fn normalize_style(spec: &serde_yaml::Value) -> Style {
    match spec {
        serde_yaml::Value::String(s) => Style {
            fg: Some(normalize_color(s)),
            bg: None,
            bold: false,
            italic: false,
            dim: false,
        },
        serde_yaml::Value::Mapping(m) => {
            let fg = m.get("fg").and_then(|v| v.as_str()).map(normalize_color);
            let bg = m.get("bg").and_then(|v| v.as_str()).map(normalize_color);
            let bold = m.get("bold").and_then(|v| v.as_bool()).unwrap_or(false);
            let italic = m.get("italic").and_then(|v| v.as_bool()).unwrap_or(false);
            let dim = m.get("dim").and_then(|v| v.as_bool()).unwrap_or(false);
            Style {
                fg,
                bg,
                bold,
                italic,
                dim,
            }
        }
        _ => Style::default(),
    }
}

impl Default for Style {
    fn default() -> Self {
        Style {
            fg: None,
            bg: None,
            bold: false,
            italic: false,
            dim: false,
        }
    }
}

fn default_colors() -> Colors {
    Colors {
        tab: Style {
            fg: Some("yellow".into()),
            ..Default::default()
        },
        pane: Style {
            fg: Some("green".into()),
            ..Default::default()
        },
        new: Style {
            fg: Some("cyan".into()),
            ..Default::default()
        },
        running: Style {
            dim: true,
            ..Default::default()
        },
        selection: Style {
            fg: Some("white".into()),
            bg: Some("blue".into()),
            bold: true,
            ..Default::default()
        },
    }
}

fn resolve_colors(raw: &serde_yaml::Value) -> Colors {
    let mut colors = default_colors();
    if let serde_yaml::Value::Mapping(m) = raw {
        if let Some(v) = m.get("tab") {
            colors.tab = normalize_style(v);
        }
        if let Some(v) = m.get("pane") {
            colors.pane = normalize_style(v);
        }
        if let Some(v) = m.get("new") {
            colors.new = normalize_style(v);
        }
        if let Some(v) = m.get("running") {
            colors.running = normalize_style(v);
        }
        if let Some(v) = m.get("selection") {
            colors.selection = normalize_style(v);
        }
    }
    colors
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

pub fn load_config() -> Config {
    let cp = config_path();
    if !cp.exists() {
        return Config {
            default: DefaultPane::default(),
            colors: default_colors(),
        };
    }
    let text = fs::read_to_string(&cp).unwrap_or_default();
    let doc: serde_yaml::Value = serde_yaml::from_str(&text).unwrap_or_default();

    let default_pane = doc
        .get("default")
        .and_then(|v| serde_yaml::from_value::<DefaultPane>(v.clone()).ok())
        .unwrap_or_default();

    let colors = doc
        .get("colors")
        .map(|v| resolve_colors(v))
        .unwrap_or_else(default_colors);

    Config {
        default: default_pane,
        colors,
    }
}

// ---------------------------------------------------------------------------
// Layout loading
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct TabsFile {
    #[serde(default)]
    tabs: Vec<LayoutTab>,
}

pub fn load_tabs() -> Vec<LayoutTab> {
    let mut tabs = Vec::new();

    let lp = layouts_path();
    if lp.exists() {
        if let Ok(text) = fs::read_to_string(&lp) {
            if let Ok(file) = serde_yaml::from_str::<TabsFile>(&text) {
                tabs.extend(file.tabs);
            }
        }
    }

    let ld = layouts_d_dir();
    if ld.is_dir() {
        let mut files: Vec<_> = fs::read_dir(&ld)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name.ends_with(".yaml") || name.ends_with(".yml")
            })
            .collect();
        files.sort_by_key(|e| e.file_name());
        for f in files {
            if let Ok(text) = fs::read_to_string(f.path()) {
                if let Ok(file) = serde_yaml::from_str::<TabsFile>(&text) {
                    tabs.extend(file.tabs);
                }
            }
        }
    }

    tabs
}

pub fn validate_tabs(tabs: &[LayoutTab]) -> Vec<String> {
    let mut errors = Vec::new();

    // Check for spaces in names
    for t in tabs {
        if t.name.contains(' ') {
            errors.push(format!(
                "Tab name \"{}\" contains spaces. Use _ instead (displayed as spaces).",
                t.name
            ));
        }
        for p in &t.panes {
            if p.name.contains(' ') {
                errors.push(format!(
                    "Pane name \"{}\" in tab \"{}\" contains spaces. Use _ instead (displayed as spaces).",
                    p.name, t.name
                ));
            }
        }
    }

    // Check duplicate tab names
    let mut seen = std::collections::HashMap::new();
    for t in tabs {
        *seen.entry(t.name.clone()).or_insert(0u32) += 1;
    }
    for (name, count) in &seen {
        if *count > 1 {
            errors.push(format!(
                "Duplicate tab name: \"{}\" (appears {} times)",
                name, count
            ));
        }
    }

    errors
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub fn resolve_dir(dir: &str) -> String {
    if dir.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return format!("{}{}", home.display(), &dir[1..]);
        }
    }
    if dir == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.display().to_string();
        }
    }
    dir.to_string()
}

/// Display name for TUI: display > name > cmd > "Shell"
pub fn pane_display(p: &LayoutPane) -> String {
    if let Some(d) = &p.display {
        if !d.is_empty() {
            return d.clone();
        }
    }
    if !p.name.is_empty() {
        return p.name.clone();
    }
    if let Some(c) = &p.cmd {
        if !c.is_empty() {
            return c.clone();
        }
    }
    "Shell".to_string()
}

/// Name for moox var: name > "Shell"
pub fn pane_name(p: &LayoutPane) -> String {
    if !p.name.is_empty() {
        return p.name.clone();
    }
    "Shell".to_string()
}

/// Display _ as space
pub fn display_name(name: &str) -> String {
    name.replace('_', " ")
}
