use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Clear, Widget},
};
use std::fs;
use std::path::Path;

// ---------------------------------------------------------------------------
// Directory input state
// ---------------------------------------------------------------------------

pub struct DirInputState {
    pub path: String,
    pub sel_idx: i32, // -1 = no selection
    pub subdirs: Vec<String>,
    pub visible: bool,
    pub prompt: String,
}

impl DirInputState {
    pub fn new(initial: &str, prompt: &str) -> Self {
        let path = compact_path(initial);
        let path = if path.ends_with('/') {
            path
        } else {
            format!("{}/", path)
        };
        let mut s = DirInputState {
            path,
            sel_idx: -1,
            subdirs: Vec::new(),
            visible: true,
            prompt: prompt.to_string(),
        };
        s.update_subdirs();
        s
    }

    pub fn update_subdirs(&mut self) {
        self.subdirs = if self.path.ends_with('/') {
            list_subdirs(&self.path)
        } else if let Some(slash) = self.path.rfind('/') {
            let parent = &self.path[..=slash];
            let query = self.path[slash + 1..].to_lowercase();
            list_subdirs(parent)
                .into_iter()
                .filter(|n| fuzzy_match(&n.to_lowercase(), &query))
                .collect()
        } else {
            Vec::new()
        };
    }

    pub fn handle_key(&mut self, key: crossterm::event::KeyEvent) -> DirInputResult {
        use crossterm::event::{KeyCode, KeyModifiers};

        match key.code {
            KeyCode::Esc => return DirInputResult::Cancel,

            KeyCode::Enter => {
                if self.sel_idx >= 0 && (self.sel_idx as usize) < self.subdirs.len() {
                    // Pick highlighted subdir
                    let picked = self.subdirs[self.sel_idx as usize].clone();
                    let last_slash = self.path.rfind('/').unwrap_or(0);
                    let parent = &self.path[..=last_slash];
                    self.path = format!("{}{}/", parent, picked);
                    self.sel_idx = -1;
                    self.update_subdirs();
                } else {
                    // Submit
                    let target = if self.path.ends_with('/') && self.path.len() > 1 {
                        &self.path[..self.path.len() - 1]
                    } else {
                        &self.path
                    };
                    let expanded = expand_path(target);
                    if Path::new(&expanded).is_dir() {
                        return DirInputResult::Submit(expanded);
                    } else {
                        // Bell
                        print!("\x07");
                    }
                }
            }

            KeyCode::Down | KeyCode::Tab => {
                if !self.subdirs.is_empty() {
                    if self.sel_idx >= self.subdirs.len() as i32 - 1 {
                        self.sel_idx = -1; // wrap to no selection
                    } else {
                        self.sel_idx += 1;
                    }
                }
            }

            KeyCode::Up | KeyCode::BackTab => {
                if !self.subdirs.is_empty() {
                    if self.sel_idx <= -1 {
                        self.sel_idx = self.subdirs.len() as i32 - 1; // wrap to bottom
                    } else {
                        self.sel_idx -= 1;
                    }
                }
            }

            KeyCode::Right | KeyCode::Char(' ')
                if !key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                if self.sel_idx >= 0 && (self.sel_idx as usize) < self.subdirs.len() {
                    let sel = &self.subdirs[self.sel_idx as usize];
                    if sel == ".." {
                        if let Some(parent) = Path::new(&expand_path(&self.path)).parent() {
                            self.path = format!("{}/", compact_path(&parent.display().to_string()));
                        }
                    } else {
                        let last_slash = self.path.rfind('/').unwrap_or(0);
                        let parent = &self.path[..=last_slash];
                        self.path = format!("{}{}/", parent, sel);
                    }
                    self.sel_idx = -1;
                    self.update_subdirs();
                }
            }

            KeyCode::Left => {
                let expanded = expand_path(&self.path);
                if let Some(parent) = Path::new(&expanded).parent() {
                    if parent != Path::new("/") || expanded != "/" {
                        self.path = format!("{}/", compact_path(&parent.display().to_string()));
                        self.sel_idx = -1;
                        self.update_subdirs();
                    }
                }
            }

            KeyCode::Char('u') | KeyCode::Char('w')
                if key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                // Delete back to previous slash
                let s = if self.path.ends_with('/') {
                    self.path[..self.path.len() - 1].to_string()
                } else {
                    self.path.clone()
                };
                if let Some(slash) = s.rfind('/') {
                    self.path = format!("{}", &s[..=slash]);
                } else {
                    self.path.clear();
                }
                self.sel_idx = -1;
                self.update_subdirs();
            }

            KeyCode::Backspace => {
                if !self.path.is_empty() {
                    self.path.pop();
                    self.sel_idx = -1;
                    self.update_subdirs();
                }
            }

            KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.path.push(c);
                self.sel_idx = -1;
                self.update_subdirs();
            }

            _ => {}
        }

        DirInputResult::Continue
    }

    pub fn render(&self, area: Rect, buf: &mut Buffer) {
        let width: u16 = 50.min(area.width.saturating_sub(4));
        let max_entries: usize = 10;
        let visible_count = self.subdirs.len().min(max_entries);
        // height: border(1) + path(1) + filter(1) + border(1) + entries + border(1)
        let height = 4 + visible_count as u16 + if self.subdirs.is_empty() { 1 } else { 0 };

        let x = area.x + (area.width.saturating_sub(width)) / 2;
        let y = area.y + 2; // Pin near top, grow downward

        let popup_area = Rect::new(x, y, width, height);

        // Clear the area behind popup
        Clear.render(popup_area, buf);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(ratatui::style::Style::default().fg(Color::Cyan))
            .title(format!(" {} ", self.prompt))
            .title_style(ratatui::style::Style::default().fg(Color::Cyan));

        let inner = block.inner(popup_area);
        block.render(popup_area, buf);

        let inner_w = inner.width as usize;

        // Path input line
        let path_display = if self.path.len() > inner_w - 2 {
            format!("\u{2026}{}", &self.path[self.path.len() - inner_w + 3..])
        } else {
            self.path.clone()
        };
        let cursor = "\u{2588}";
        let display = format!(" {}{}", path_display, cursor);
        buf.set_string(
            inner.x,
            inner.y,
            &display,
            Style::default().add_modifier(Modifier::BOLD),
        );

        // Separator
        let sep_y = inner.y + 1;
        let sep = format!("{}{}{}", "\u{251c}", "\u{2500}".repeat(inner_w), "\u{2524}");
        buf.set_string(popup_area.x, sep_y, &sep, Style::default().fg(Color::Cyan));

        // Entries
        let entries_start = sep_y + 1;
        if self.subdirs.is_empty() {
            buf.set_string(
                inner.x,
                entries_start,
                " (no subdirs)",
                Style::default().add_modifier(Modifier::DIM),
            );
        } else {
            for (i, name) in self.subdirs.iter().take(max_entries).enumerate() {
                let is_sel = i as i32 == self.sel_idx;
                let display_name = format!("{}/", name);
                let truncated = if display_name.len() > inner_w - 2 {
                    format!("{}...", &display_name[..inner_w - 5])
                } else {
                    display_name
                };
                let pad = inner_w.saturating_sub(truncated.len() + 2);
                let line = format!(" {}{}", truncated, " ".repeat(pad + 1));

                let style = if is_sel {
                    Style::default().fg(Color::White).bg(Color::Blue)
                } else {
                    Style::default()
                };
                buf.set_string(inner.x, entries_start + i as u16, &line, style);
            }
        }
    }
}

pub enum DirInputResult {
    Continue,
    Submit(String),
    Cancel,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn compact_path(p: &str) -> String {
    if let Some(home) = dirs::home_dir() {
        let home_str = home.display().to_string();
        if p == home_str {
            return "~".to_string();
        }
        if let Some(rest) = p.strip_prefix(&format!("{}/", home_str)) {
            return format!("~/{}", rest);
        }
    }
    p.to_string()
}

fn expand_path(p: &str) -> String {
    if p.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return format!("{}{}", home.display(), &p[1..]);
        }
    }
    if p == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.display().to_string();
        }
    }
    p.to_string()
}

fn list_subdirs(path_str: &str) -> Vec<String> {
    let expanded = expand_path(path_str);
    let path = Path::new(&expanded);
    match fs::read_dir(path) {
        Ok(entries) => {
            let mut dirs: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_type().map(|ft| ft.is_dir()).unwrap_or(false)
                        && !e.file_name().to_string_lossy().starts_with('.')
                })
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            dirs.sort();
            dirs
        }
        Err(_) => Vec::new(),
    }
}

fn fuzzy_match(s: &str, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    let mut qi = query.chars().peekable();
    for ch in s.chars() {
        if qi.peek() == Some(&ch) {
            qi.next();
            if qi.peek().is_none() {
                return true;
            }
        }
    }
    false
}
