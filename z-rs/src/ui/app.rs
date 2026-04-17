use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::{
    buffer::Buffer,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Widget},
    Frame,
};

use super::dir_input::{DirInputResult, DirInputState};
use super::panel::{PanelItem, PanelState, PanelWidget};
use crate::config::{self, Colors};
use crate::moox;
use crate::picker_action::PickerAction;

// ---------------------------------------------------------------------------
// Picker data + result
// ---------------------------------------------------------------------------

pub struct PickerData {
    pub layout_items: Vec<PanelItem>,
    pub running_items: Vec<PanelItem>,
    pub left_title: Option<String>,
}

pub struct PickerResult {
    pub action: Option<PickerAction>,
    pub dir: Option<String>,
}

// ---------------------------------------------------------------------------
// Preview state
// ---------------------------------------------------------------------------

struct PreviewState {
    content: Vec<Line<'static>>,
    scroll_y: usize,
    scroll_x: usize,
    session_id: String,
    pane_name: String,
    viewport_height: usize,
    follow_bottom: bool,
}

impl PreviewState {
    fn new() -> Self {
        PreviewState {
            content: Vec::new(),
            scroll_y: 0,
            scroll_x: 0,
            session_id: String::new(),
            pane_name: String::new(),
            viewport_height: 0,
            follow_bottom: true,
        }
    }

    fn load(&mut self, id: &str, pane_name: &str) {
        if id == self.session_id {
            return; // Already loaded
        }
        self.session_id = id.to_string();
        self.pane_name = pane_name.to_string();
        self.refresh();
    }

    fn refresh(&mut self) {
        if self.session_id.is_empty() {
            self.content.clear();
            return;
        }
        let raw = moox::moox_history(&self.session_id);
        self.content = moox::ansi_lines(&raw);
        if self.follow_bottom {
            self.scroll_y = self.max_scroll_y();
        } else {
            self.scroll_y = self.scroll_y.min(self.max_scroll_y());
        }
    }

    fn clear(&mut self) {
        self.content.clear();
        self.session_id.clear();
        self.pane_name.clear();
        self.scroll_y = 0;
        self.scroll_x = 0;
        self.viewport_height = 0;
        self.follow_bottom = true;
    }

    fn scroll_up(&mut self, n: usize) {
        if self.follow_bottom {
            self.scroll_y = self.max_scroll_y();
            self.follow_bottom = false;
        }
        self.scroll_y = self.scroll_y.saturating_sub(n);
    }

    fn scroll_down(&mut self, n: usize, height: usize) {
        self.viewport_height = height;
        let max = self.content.len().saturating_sub(height);
        self.scroll_y = (self.scroll_y + n).min(max);
        self.follow_bottom = self.scroll_y >= max;
    }

    fn scroll_left(&mut self, n: usize) {
        self.scroll_x = self.scroll_x.saturating_sub(n);
    }

    fn scroll_right(&mut self, n: usize) {
        self.scroll_x += n;
    }

    fn title(&self) -> String {
        if self.session_id.is_empty() {
            "Preview".to_string()
        } else {
            let pane = if self.pane_name.is_empty() {
                &self.session_id
            } else {
                &self.pane_name
            };
            format!("{} [{}]", config::display_name(pane), self.session_id)
        }
    }

    fn max_scroll_y(&self) -> usize {
        self.content.len().saturating_sub(self.viewport_height)
    }
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

enum Overlay {
    None,
    DirInput(DirInputState),
    KillConfirm { ids: Vec<String>, label: String },
}

#[derive(Clone, Copy, PartialEq)]
enum ActivePanel {
    Layouts,
    Running,
    Preview,
}

pub struct DirNeeds {
    pub initial: String,
}

pub struct App {
    layout_panel: PanelState,
    running_panel: PanelState,
    preview: PreviewState,
    active_panel: ActivePanel,
    overlay: Overlay,
    colors: Colors,
    left_title: String,
    result: PickerResult,
    should_quit: bool,
    needs_dir_fn: Box<dyn Fn(&PickerAction) -> Option<DirNeeds>>,
    refresh_fn: Box<dyn Fn() -> PickerData>,
    pub kill_poll_ids: Option<Vec<String>>,
    kill_poll_count: u32,
}

impl App {
    pub fn new(
        data: PickerData,
        colors: Colors,
        needs_dir_fn: Box<dyn Fn(&PickerAction) -> Option<DirNeeds>>,
        refresh_fn: Box<dyn Fn() -> PickerData>,
    ) -> Self {
        let left_title = data
            .left_title
            .clone()
            .unwrap_or_else(|| "Layouts".to_string());
        let mut app = App {
            layout_panel: PanelState::new(data.layout_items),
            running_panel: PanelState::new(data.running_items),
            preview: PreviewState::new(),
            active_panel: ActivePanel::Layouts,
            overlay: Overlay::None,
            colors,
            left_title,
            result: PickerResult {
                action: None,
                dir: None,
            },
            should_quit: false,
            needs_dir_fn,
            refresh_fn,
            kill_poll_ids: None,
            kill_poll_count: 0,
        };
        app.update_preview();
        app
    }

    fn active_state(&mut self) -> &mut PanelState {
        match self.active_panel {
            ActivePanel::Layouts => &mut self.layout_panel,
            ActivePanel::Running => &mut self.running_panel,
            ActivePanel::Preview => &mut self.running_panel, // shouldn't navigate panel items when in preview
        }
    }

    fn has_running(&self) -> bool {
        !self.running_panel.items.is_empty()
    }

    fn update_preview(&mut self) {
        // Show preview for the selected running pane
        if let Some(item) = self.running_panel.selected_item() {
            if let Some(PickerAction::OpenExistingPane {
                session_id,
                pane_title,
            }) = item.action.as_ref()
            {
                let pane_name = pane_title.as_deref().unwrap_or("");
                let id = session_id.as_str();
                self.preview.load(id, pane_name);
                return;
            }
        }
        self.preview.clear();
    }

    fn reload_preview_preserving_scroll(&mut self) {
        if let Some(item) = self.running_panel.selected_item() {
            if let Some(PickerAction::OpenExistingPane {
                session_id,
                pane_title,
            }) = item.action.as_ref()
            {
                let pane_name = pane_title.as_deref().unwrap_or("");
                let id = session_id.as_str();
                if id == self.preview.session_id {
                    self.preview.pane_name = pane_name.to_string();
                    self.preview.refresh();
                } else {
                    self.preview.load(id, pane_name);
                }
                return;
            }
        }
        self.preview.clear();
    }

    fn refresh(&mut self) {
        let data = (self.refresh_fn)();
        self.left_title = data.left_title.unwrap_or_else(|| "Layouts".to_string());
        let lc = self.layout_panel.cursor_idx;
        let rc = self.running_panel.cursor_idx;
        self.layout_panel = PanelState::new(data.layout_items);
        self.running_panel = PanelState::new(data.running_items);
        self.layout_panel.cursor_idx = lc.min(
            self.layout_panel
                .items
                .iter()
                .filter(|i| i.selectable)
                .count()
                .saturating_sub(1),
        );
        self.running_panel.cursor_idx = rc.min(
            self.running_panel
                .items
                .iter()
                .filter(|i| i.selectable)
                .count()
                .saturating_sub(1),
        );
        self.reload_preview_preserving_scroll();
    }

    fn handle_select(&mut self, action: PickerAction) {
        if let Some(check) = (self.needs_dir_fn)(&action) {
            let initial = check.initial;
            self.overlay =
                Overlay::DirInput(DirInputState::new(&initial, "Select start directory"));
            self.result.action = Some(action);
            return;
        }

        self.result.action = Some(action);
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
        // Overlay handling
        match &mut self.overlay {
            Overlay::DirInput(state) => {
                match state.handle_key(key) {
                    DirInputResult::Submit(dir) => {
                        self.result.dir = Some(dir);
                        self.overlay = Overlay::None;
                        self.should_quit = true;
                    }
                    DirInputResult::Cancel => {
                        self.result.action = None;
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
            KeyCode::Tab => {
                // Cycle panels: Layouts -> Running -> Preview -> Layouts
                self.active_panel = match self.active_panel {
                    ActivePanel::Layouts => {
                        if self.has_running() {
                            ActivePanel::Running
                        } else {
                            ActivePanel::Layouts
                        }
                    }
                    ActivePanel::Running => {
                        if !self.preview.content.is_empty() {
                            ActivePanel::Preview
                        } else {
                            ActivePanel::Layouts
                        }
                    }
                    ActivePanel::Preview => ActivePanel::Layouts,
                };
            }
            KeyCode::BackTab => {
                // Reverse cycle
                self.active_panel = match self.active_panel {
                    ActivePanel::Layouts => {
                        if !self.preview.content.is_empty() {
                            ActivePanel::Preview
                        } else if self.has_running() {
                            ActivePanel::Running
                        } else {
                            ActivePanel::Layouts
                        }
                    }
                    ActivePanel::Running => ActivePanel::Layouts,
                    ActivePanel::Preview => ActivePanel::Running,
                };
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if self.active_panel == ActivePanel::Preview {
                    self.preview.scroll_up(1);
                } else {
                    self.active_state().move_up();
                    if self.active_panel == ActivePanel::Running {
                        self.update_preview();
                    }
                }
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.active_panel == ActivePanel::Preview {
                    self.preview.scroll_down(1, 20); // rough height, will be corrected in render
                } else {
                    self.active_state().move_down();
                    if self.active_panel == ActivePanel::Running {
                        self.update_preview();
                    }
                }
            }
            KeyCode::Left | KeyCode::Char('h') => {
                if self.active_panel == ActivePanel::Preview {
                    self.preview.scroll_left(4);
                }
            }
            KeyCode::Right | KeyCode::Char('l') => {
                if self.active_panel == ActivePanel::Preview {
                    self.preview.scroll_right(4);
                }
            }
            KeyCode::Char('G') | KeyCode::Char('$') => {
                if self.active_panel == ActivePanel::Preview {
                    self.preview.follow_bottom = true;
                    self.preview.scroll_y = self.preview.max_scroll_y();
                } else {
                    self.active_state().move_bottom();
                    if self.active_panel == ActivePanel::Running {
                        self.update_preview();
                    }
                }
            }
            KeyCode::Char('g') | KeyCode::Char('0') => {
                if self.active_panel == ActivePanel::Preview {
                    self.preview.follow_bottom = false;
                    self.preview.scroll_y = 0;
                    self.preview.scroll_x = 0;
                } else {
                    self.active_state().move_top();
                    if self.active_panel == ActivePanel::Running {
                        self.update_preview();
                    }
                }
            }
            KeyCode::Char('K') => {
                if let Some(action) = self.active_state().selected_action().cloned() {
                    if let PickerAction::OpenExistingPane { session_id, .. } = action {
                        let id = session_id;
                        self.overlay = Overlay::KillConfirm {
                            ids: vec![id.clone()],
                            label: id[..8.min(id.len())].to_string(),
                        };
                    } else if let PickerAction::OpenExistingTab { tab_name } = action {
                        let sessions = moox::list_sessions();
                        let panes = moox::panes_for_tab(&sessions, &tab_name);
                        if !panes.is_empty() {
                            let ids: Vec<String> = panes.iter().map(|p| p.id.clone()).collect();
                            self.overlay = Overlay::KillConfirm {
                                ids,
                                label: format!(
                                    "tab \"{}\" ({} panes)",
                                    config::display_name(&tab_name),
                                    panes.len()
                                ),
                            };
                        }
                    }
                }
            }
            KeyCode::Enter => {
                if self.active_panel != ActivePanel::Preview {
                    if let Some(action) = self.active_state().selected_action().cloned() {
                        self.handle_select(action);
                    }
                }
            }
            _ => {}
        }
    }

    pub fn render(&mut self, frame: &mut Frame) {
        let area = frame.area();
        let has_running = self.has_running();
        let has_preview = !self.preview.content.is_empty();

        // Calculate widths
        let panel_width = if has_running {
            (area.width / 4).min(40).max(20)
        } else {
            area.width.min(50)
        };

        let preview_width = if has_running && has_preview {
            area.width.saturating_sub(panel_width * 2)
        } else {
            0
        };

        let total_width = if has_running {
            panel_width * 2 + preview_width
        } else {
            panel_width
        };

        // Main layout: panels + bottom bar
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(3), Constraint::Length(1)])
            .split(Rect::new(0, 0, total_width, area.height));

        let panel_area = chunks[0];
        let bar_area = chunks[1];

        if has_running {
            let mut constraints = vec![
                Constraint::Length(panel_width),
                Constraint::Length(panel_width),
            ];
            if has_preview {
                constraints.push(Constraint::Min(10));
            }

            let panel_chunks = Layout::default()
                .direction(Direction::Horizontal)
                .constraints(constraints)
                .split(panel_area);

            PanelWidget {
                state: &mut self.layout_panel,
                title: &self.left_title,
                focused: matches!(self.overlay, Overlay::None)
                    && self.active_panel == ActivePanel::Layouts,
                show_selection_when_unfocused: false,
                colors: &self.colors,
            }
            .render(panel_chunks[0], frame.buffer_mut());

            PanelWidget {
                state: &mut self.running_panel,
                title: "Running",
                focused: matches!(self.overlay, Overlay::None)
                    && self.active_panel == ActivePanel::Running,
                show_selection_when_unfocused: true,
                colors: &self.colors,
            }
            .render(panel_chunks[1], frame.buffer_mut());

            if has_preview && panel_chunks.len() > 2 {
                self.render_preview(panel_chunks[2], frame.buffer_mut());
            }
        } else {
            PanelWidget {
                state: &mut self.layout_panel,
                title: &self.left_title,
                focused: matches!(self.overlay, Overlay::None),
                show_selection_when_unfocused: false,
                colors: &self.colors,
            }
            .render(
                Rect::new(0, 0, panel_width, panel_area.height),
                frame.buffer_mut(),
            );
        }

        // Bottom bar
        let bar_spans = vec![
            Span::raw(" "),
            Span::styled(
                "z",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" \u{2502} ", Style::default().add_modifier(Modifier::DIM)),
            Span::styled(
                "Tab",
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" panel  ", Style::default().add_modifier(Modifier::DIM)),
            Span::styled(
                "Enter",
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" select  ", Style::default().add_modifier(Modifier::DIM)),
            Span::styled(
                "^L",
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" refresh  ", Style::default().add_modifier(Modifier::DIM)),
            Span::styled(
                "q",
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
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

    fn render_preview(&mut self, area: Rect, buf: &mut Buffer) {
        let focused =
            matches!(self.overlay, Overlay::None) && self.active_panel == ActivePanel::Preview;
        let border_color = if focused {
            Color::Cyan
        } else {
            Color::DarkGray
        };

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(border_color))
            .title(format!(" {} ", self.preview.title()))
            .title_style(Style::default().fg(border_color));

        let inner = block.inner(area);
        block.render(area, buf);

        let height = inner.height as usize;
        let width = inner.width as usize;
        self.preview.viewport_height = height;
        if self.preview.follow_bottom {
            self.preview.scroll_y = self.preview.max_scroll_y();
        } else {
            self.preview.scroll_y = self.preview.scroll_y.min(self.preview.max_scroll_y());
        }
        let scroll_y = self.preview.scroll_y;

        for row in 0..height {
            let line_idx = scroll_y + row;
            if line_idx >= self.preview.content.len() {
                break;
            }
            let line = clip_line(
                &self.preview.content[line_idx],
                self.preview.scroll_x,
                width,
            );
            buf.set_line(inner.x, inner.y + row as u16, &line, inner.width);
        }
    }

    pub fn should_quit(&self) -> bool {
        self.should_quit
    }

    pub fn into_result(self) -> PickerResult {
        self.result
    }

    pub fn tick(&mut self) {
        if self.kill_poll_ids.is_some() {
            self.kill_poll_count += 1;
            self.refresh();
            let ids = self.kill_poll_ids.as_ref().unwrap();
            let id_set: std::collections::HashSet<_> = ids.iter().collect();
            let still_alive = self.running_panel.items.iter().any(|item| {
                matches!(
                    item.action.as_ref(),
                    Some(PickerAction::OpenExistingPane { session_id, .. })
                        if id_set.contains(session_id)
                )
            });
            if !still_alive || self.kill_poll_count >= 50 {
                self.kill_poll_ids = None;
            }
        }
    }
}

fn clip_line(line: &Line<'static>, scroll_x: usize, width: usize) -> Line<'static> {
    if width == 0 {
        return Line::default();
    }

    let mut skipped = 0usize;
    let mut taken = 0usize;
    let mut spans = Vec::new();

    for span in &line.spans {
        if taken >= width {
            break;
        }

        let span_text = span.content.as_ref();
        let span_len = span_text.chars().count();
        if skipped + span_len <= scroll_x {
            skipped += span_len;
            continue;
        }

        let local_start = scroll_x.saturating_sub(skipped);
        let remaining = width - taken;
        let visible: String = span_text
            .chars()
            .skip(local_start)
            .take(remaining)
            .collect();
        let visible_len = visible.chars().count();

        if !visible.is_empty() {
            spans.push(Span::styled(visible, span.style));
            taken += visible_len;
        }

        skipped += span_len;
    }

    Line::from(spans)
}
