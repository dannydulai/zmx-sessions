use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::{
    buffer::Buffer,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Widget},
    Frame, Terminal,
};
use std::collections::HashMap;
use std::time::Duration;

use crate::config::{self, Colors, Config, LayoutTab};
use crate::moox::{self, MooxSession};
use super::dir_input::{DirInputState, DirInputResult};
use super::panel::{PanelItem, PanelState, PanelWidget, ItemType};

// ---------------------------------------------------------------------------
// Picker data + result
// ---------------------------------------------------------------------------

pub struct PickerData {
    pub layout_items: Vec<PanelItem>,
    pub running_items: Vec<PanelItem>,
    pub left_title: Option<String>,
}

pub struct PickerResult {
    pub choice: Option<String>,
    pub dir: Option<String>,
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

enum Overlay {
    None,
    DirInput(DirInputState),
    KillConfirm { ids: Vec<String>, label: String },
}

pub struct App {
    layout_panel: PanelState,
    running_panel: PanelState,
    active_panel: ActivePanel,
    overlay: Overlay,
    colors: Colors,
    left_title: String,
    result: PickerResult,
    should_quit: bool,
    needs_dir_fn: Box<dyn Fn(&str) -> Option<DirNeeds>>,
    refresh_fn: Box<dyn Fn() -> PickerData>,
    // Kill polling
    pub kill_poll_ids: Option<Vec<String>>,
    kill_poll_count: u32,
}

#[derive(Clone, Copy, PartialEq)]
enum ActivePanel {
    Layouts,
    Running,
}

pub struct DirNeeds {
    pub initial: String,
}

impl App {
    pub fn new(
        data: PickerData,
        colors: Colors,
        needs_dir_fn: Box<dyn Fn(&str) -> Option<DirNeeds>>,
        refresh_fn: Box<dyn Fn() -> PickerData>,
    ) -> Self {
        let left_title = data.left_title.clone().unwrap_or_else(|| "Layouts".to_string());
        App {
            layout_panel: PanelState::new(data.layout_items),
            running_panel: PanelState::new(data.running_items),
            active_panel: ActivePanel::Layouts,
            overlay: Overlay::None,
            colors,
            left_title,
            result: PickerResult { choice: None, dir: None },
            should_quit: false,
            needs_dir_fn,
            refresh_fn,
            kill_poll_ids: None,
            kill_poll_count: 0,
        }
    }

    fn active_state(&mut self) -> &mut PanelState {
        match self.active_panel {
            ActivePanel::Layouts => &mut self.layout_panel,
            ActivePanel::Running => &mut self.running_panel,
        }
    }

    fn has_running(&self) -> bool {
        !self.running_panel.items.is_empty()
    }

    fn refresh(&mut self) {
        let data = (self.refresh_fn)();
        self.left_title = data.left_title.unwrap_or_else(|| "Layouts".to_string());
        // Preserve cursor positions roughly
        let lc = self.layout_panel.cursor_idx;
        let rc = self.running_panel.cursor_idx;
        self.layout_panel = PanelState::new(data.layout_items);
        self.running_panel = PanelState::new(data.running_items);
        self.layout_panel.cursor_idx = lc.min(
            self.layout_panel.items.iter().filter(|i| i.selectable).count().saturating_sub(1),
        );
        self.running_panel.cursor_idx = rc.min(
            self.running_panel.items.iter().filter(|i| i.selectable).count().saturating_sub(1),
        );
    }

    fn handle_select(&mut self, value: String) {
        if value == "new:" {
            // Show dir input for new tab
            let check = (self.needs_dir_fn)(&value);
            let initial = check
                .map(|c| c.initial)
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_default().display().to_string());
            self.overlay = Overlay::DirInput(DirInputState::new(&initial, "Select start directory"));
            return;
        }

        if let Some(check) = (self.needs_dir_fn)(&value) {
            self.overlay = Overlay::DirInput(DirInputState::new(&check.initial, "Select start directory"));
            // Store the value we're getting dir for
            self.result.choice = Some(value);
            return;
        }

        self.result.choice = Some(value);
        self.should_quit = true;
    }

    pub fn handle_event(&mut self, ev: Event) {
        if let Event::Key(key) = ev {
            if key.kind == KeyEventKind::Release {
                return;
            }
            self.handle_key(key);
        }
    }

    fn handle_key(&mut self, key: KeyEvent) {
        // Kill poll tick handled in run loop, not here

        // Overlay handling
        match &mut self.overlay {
            Overlay::DirInput(state) => {
                match state.handle_key(key) {
                    DirInputResult::Submit(dir) => {
                        if self.result.choice.is_none() {
                            // This was a "new:" dir selection
                            self.result.choice = Some("new:".to_string());
                        }
                        self.result.dir = Some(dir);
                        self.overlay = Overlay::None;
                        self.should_quit = true;
                    }
                    DirInputResult::Cancel => {
                        self.result.choice = None;
                        self.result.dir = None;
                        self.overlay = Overlay::None;
                    }
                    DirInputResult::Continue => {}
                }
                return;
            }
            Overlay::KillConfirm { ids, .. } => {
                match key.code {
                    KeyCode::Char('y') | KeyCode::Char('Y') => {
                        let ids_clone = ids.clone();
                        for id in &ids_clone {
                            moox::moox_kill(id);
                        }
                        self.kill_poll_ids = Some(ids_clone);
                        self.kill_poll_count = 0;
                        self.overlay = Overlay::None;
                    }
                    _ => {
                        self.overlay = Overlay::None;
                    }
                }
                return;
            }
            Overlay::None => {}
        }

        match key.code {
            KeyCode::Char('q') | KeyCode::Esc => {
                self.should_quit = true;
            }
            KeyCode::Char('c') | KeyCode::Char('d')
                if key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                self.should_quit = true;
            }
            KeyCode::Char('l') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.refresh();
            }
            KeyCode::Tab
            | KeyCode::Char('h')
            | KeyCode::Char('l')
            | KeyCode::Left
            | KeyCode::Right => {
                if self.has_running() {
                    self.active_panel = match self.active_panel {
                        ActivePanel::Layouts => ActivePanel::Running,
                        ActivePanel::Running => ActivePanel::Layouts,
                    };
                }
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.active_state().move_up();
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.active_state().move_down();
            }
            KeyCode::Char('G') | KeyCode::Char('$') => {
                self.active_state().move_bottom();
            }
            KeyCode::Char('g') | KeyCode::Char('0') => {
                self.active_state().move_top();
            }
            KeyCode::Char('K') => {
                // Kill
                if let Some(value) = self.active_state().selected_value().map(|s| s.to_string()) {
                    if value.starts_with("existing-pane:") {
                        let id = value["existing-pane:".len()..].to_string();
                        self.overlay = Overlay::KillConfirm {
                            ids: vec![id.clone()],
                            label: id[..8.min(id.len())].to_string(),
                        };
                    } else if value.starts_with("existing-tab:") {
                        let tab_name = value["existing-tab:".len()..].to_string();
                        let sessions = moox::list_sessions();
                        let panes = moox::panes_for_tab(&sessions, &tab_name);
                        if !panes.is_empty() {
                            let ids: Vec<String> = panes.iter().map(|p| p.id.clone()).collect();
                            self.overlay = Overlay::KillConfirm {
                                ids,
                                label: format!("tab \"{}\" ({} panes)", config::display_name(&tab_name), panes.len()),
                            };
                        }
                    }
                }
            }
            KeyCode::Enter => {
                if let Some(value) = self.active_state().selected_value().map(|s| s.to_string()) {
                    self.handle_select(value);
                }
            }
            _ => {}
        }
    }

    pub fn render(&mut self, frame: &mut Frame) {
        let area = frame.area();
        let has_running = self.has_running();

        let panel_width = if has_running {
            (area.width / 2).min(50)
        } else {
            area.width.min(50)
        };
        let total_width = if has_running { panel_width * 2 } else { panel_width };

        // Main layout: panels + bottom bar
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(3),
                Constraint::Length(1),
            ])
            .split(Rect::new(0, 0, total_width, area.height));

        let panel_area = chunks[0];
        let bar_area = chunks[1];

        // Panels side by side
        if has_running {
            let panel_chunks = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([
                    Constraint::Length(panel_width),
                    Constraint::Length(panel_width),
                ])
                .split(panel_area);

            PanelWidget {
                state: &mut self.layout_panel,
                title: &self.left_title,
                focused: matches!(self.overlay, Overlay::None) && self.active_panel == ActivePanel::Layouts,
                colors: &self.colors,
            }
            .render(panel_chunks[0], frame.buffer_mut());

            PanelWidget {
                state: &mut self.running_panel,
                title: "Running",
                focused: matches!(self.overlay, Overlay::None) && self.active_panel == ActivePanel::Running,
                colors: &self.colors,
            }
            .render(panel_chunks[1], frame.buffer_mut());
        } else {
            PanelWidget {
                state: &mut self.layout_panel,
                title: &self.left_title,
                focused: matches!(self.overlay, Overlay::None),
                colors: &self.colors,
            }
            .render(Rect::new(0, 0, panel_width, panel_area.height), frame.buffer_mut());
        }

        // Bottom bar
        let bar_spans = vec![
            Span::raw(" "),
            Span::styled("z", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            Span::styled(" \u{2502} ", Style::default().add_modifier(Modifier::DIM)),
            Span::styled("Tab", Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
            Span::styled(" panel  ", Style::default().add_modifier(Modifier::DIM)),
            Span::styled("Enter", Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
            Span::styled(" select  ", Style::default().add_modifier(Modifier::DIM)),
            Span::styled("^L", Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
            Span::styled(" refresh  ", Style::default().add_modifier(Modifier::DIM)),
            Span::styled("q", Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
            Span::styled(" quit", Style::default().add_modifier(Modifier::DIM)),
        ];
        let bar = Paragraph::new(Line::from(bar_spans));
        frame.render_widget(bar, Rect::new(0, bar_area.y, total_width, 1));

        // Overlays
        match &self.overlay {
            Overlay::DirInput(state) => {
                state.render(area, frame.buffer_mut());
            }
            Overlay::KillConfirm { label, .. } => {
                let msg = format!(" Kill {}? (y/n) ", label);
                let w = msg.len() as u16 + 2;
                let h = 3u16;
                let x = (area.width.saturating_sub(w)) / 2;
                let y = (area.height.saturating_sub(h)) / 2;
                let popup = Rect::new(x, y, w, h);
                Clear.render(popup, frame.buffer_mut());
                let block = Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Cyan));
                let inner = block.inner(popup);
                block.render(popup, frame.buffer_mut());
                frame.buffer_mut().set_string(
                    inner.x,
                    inner.y,
                    &msg,
                    Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
                );
            }
            Overlay::None => {}
        }
    }

    pub fn should_quit(&self) -> bool {
        self.should_quit
    }

    pub fn into_result(self) -> PickerResult {
        self.result
    }

    pub fn tick(&mut self) {
        // Kill poll
        if self.kill_poll_ids.is_some() {
            self.kill_poll_count += 1;
            self.refresh();
            let ids = self.kill_poll_ids.as_ref().unwrap();
            let id_set: std::collections::HashSet<_> = ids.iter().collect();
            let still_alive = self.running_panel.items.iter().any(|item| {
                if item.value.starts_with("existing-pane:") {
                    let id = &item.value["existing-pane:".len()..];
                    id_set.contains(&id.to_string())
                } else {
                    false
                }
            });
            if !still_alive || self.kill_poll_count >= 50 {
                self.kill_poll_ids = None;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Run the picker
// ---------------------------------------------------------------------------

pub fn run_picker<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
    data: PickerData,
    colors: Colors,
    needs_dir_fn: Box<dyn Fn(&str) -> Option<DirNeeds>>,
    refresh_fn: Box<dyn Fn() -> PickerData>,
) -> PickerResult {
    let mut app = App::new(data, colors, needs_dir_fn, refresh_fn);

    loop {
        terminal.draw(|f| app.render(f)).unwrap();

        if app.should_quit() {
            break;
        }

        let timeout = if app.kill_poll_ids.is_some() {
            Duration::from_millis(100)
        } else {
            Duration::from_millis(250)
        };

        if event::poll(timeout).unwrap_or(false) {
            if let Ok(ev) = event::read() {
                app.handle_event(ev);
            }
        } else if app.kill_poll_ids.is_some() {
            app.tick();
        }
    }

    app.into_result()
}
