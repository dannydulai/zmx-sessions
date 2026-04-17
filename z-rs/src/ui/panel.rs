use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Widget},
};
use crate::picker_action::PickerAction;

// ---------------------------------------------------------------------------
// Panel item
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PanelItem {
    pub label: String,
    pub action: Option<PickerAction>,
    pub selectable: bool,
    pub indent: u16,
    pub item_type: ItemType,
    pub suffix: Option<String>,
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ItemType {
    Tab,
    Pane,
    New,
    Header,
    Blank,
}

impl PanelItem {
    pub fn blank() -> Self {
        PanelItem {
            label: String::new(),
            action: None,
            selectable: false,
            indent: 0,
            item_type: ItemType::Blank,
            suffix: None,
            id: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Panel state
// ---------------------------------------------------------------------------

pub struct PanelState {
    pub items: Vec<PanelItem>,
    pub cursor_idx: usize, // index into selectable items
    pub scroll_offset: usize,
    selectable_indices: Vec<usize>,
}

impl PanelState {
    pub fn new(items: Vec<PanelItem>) -> Self {
        let selectable_indices: Vec<usize> = items
            .iter()
            .enumerate()
            .filter(|(_, item)| item.selectable)
            .map(|(i, _)| i)
            .collect();
        PanelState {
            items,
            cursor_idx: 0,
            scroll_offset: 0,
            selectable_indices,
        }
    }

    pub fn move_up(&mut self) {
        if self.cursor_idx > 0 {
            self.cursor_idx -= 1;
        }
    }

    pub fn move_down(&mut self) {
        if self.cursor_idx + 1 < self.selectable_indices.len() {
            self.cursor_idx += 1;
        }
    }

    pub fn move_top(&mut self) {
        self.cursor_idx = 0;
    }

    pub fn move_bottom(&mut self) {
        if !self.selectable_indices.is_empty() {
            self.cursor_idx = self.selectable_indices.len() - 1;
        }
    }

    pub fn selected_action(&self) -> Option<&PickerAction> {
        self.selectable_indices
            .get(self.cursor_idx)
            .and_then(|&idx| self.items.get(idx))
            .and_then(|item| item.action.as_ref())
    }

    pub fn selected_item(&self) -> Option<&PanelItem> {
        self.selectable_indices
            .get(self.cursor_idx)
            .and_then(|&idx| self.items.get(idx))
    }

    fn ensure_visible(&mut self, height: usize) {
        if self.selectable_indices.is_empty() {
            return;
        }
        let item_idx = self.selectable_indices[self.cursor_idx];
        if item_idx < self.scroll_offset {
            self.scroll_offset = item_idx;
        } else if item_idx >= self.scroll_offset + height {
            self.scroll_offset = item_idx - height + 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Panel widget
// ---------------------------------------------------------------------------

pub struct PanelWidget<'a> {
    pub state: &'a mut PanelState,
    pub title: &'a str,
    pub focused: bool,
    pub show_selection_when_unfocused: bool,
    pub colors: &'a crate::config::Colors,
}

impl<'a> PanelWidget<'a> {
    pub fn render(self, area: Rect, buf: &mut Buffer) {
        let border_color = if self.focused {
            Color::Cyan
        } else {
            Color::DarkGray
        };

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(border_color))
            .title(format!(" {} ", self.title))
            .title_style(Style::default().fg(border_color));

        let inner = block.inner(area);
        block.render(area, buf);

        let height = inner.height as usize;
        self.state.ensure_visible(height);

        for row in 0..height {
            let item_idx = self.state.scroll_offset + row;
            let y = inner.y + row as u16;

            if item_idx >= self.state.items.len() {
                // Empty row
                continue;
            }

            let item = &self.state.items[item_idx];
            let is_selected = self
                .state
                .selectable_indices
                .get(self.state.cursor_idx)
                .map(|&i| i == item_idx)
                .unwrap_or(false);

            let indent = "  ".repeat(item.indent as usize);
            let label_text = format!("  {}{}", indent, item.label);

            let id_text = item
                .id
                .as_ref()
                .map(|id| format!(" [{}]", id))
                .unwrap_or_default();

            let suffix_text = item
                .suffix
                .as_ref()
                .map(|s| format!("  {}", s))
                .unwrap_or_default();

            let inner_width = inner.width as usize;

            let show_unfocused_selection = self.show_selection_when_unfocused
                && matches!(item.item_type, ItemType::Pane);

            if is_selected && (self.focused || show_unfocused_selection) {
                let sel = &self.colors.selection;
                let bg = if self.focused {
                    parse_color(sel.bg.as_deref()).unwrap_or(Color::Blue)
                } else {
                    Color::Rgb(0x12, 0x12, 0x12)
                };
                let fg = if self.focused {
                    parse_color(sel.fg.as_deref()).unwrap_or(Color::White)
                } else {
                    Color::Cyan
                };
                let mut style = Style::default().fg(fg).bg(bg);
                if self.focused && sel.bold {
                    style = style.add_modifier(Modifier::BOLD);
                } else if !self.focused {
                    style = style.add_modifier(Modifier::DIM);
                }

                // Render full-width selection bar
                let content = format!("{}{}{}", label_text, id_text, suffix_text);
                let pad = inner_width.saturating_sub(visible_width(&content));
                let padded = format!("{}{}", content, " ".repeat(pad));
                let truncated = truncate_str(&padded, inner_width);
                buf.set_string(inner.x, y, &truncated, style);
            } else if !item.selectable {
                let style = item_style(&item.item_type, self.colors).add_modifier(Modifier::DIM);
                let content = label_text;
                let pad = inner_width.saturating_sub(visible_width(&content));
                let full = format!("{}{}", content, " ".repeat(pad));
                let truncated = truncate_str(&full, inner_width);
                buf.set_string(inner.x, y, &truncated, style);
            } else {
                let style = item_style(&item.item_type, self.colors);
                let id_style = Style::default().fg(Color::DarkGray);
                let suffix_style = Style::default().add_modifier(Modifier::DIM);

                let label_w = visible_width(&label_text);
                let id_w = visible_width(&id_text);
                let suffix_w = visible_width(&suffix_text);
                let total = label_w + id_w + suffix_w;

                // Truncate if needed
                if total > inner_width {
                    // Just render what fits
                    let truncated = truncate_str(&label_text, inner_width);
                    buf.set_string(inner.x, y, &truncated, style);
                } else {
                    let pad = inner_width - total;
                    buf.set_string(inner.x, y, &label_text, style);
                    if !id_text.is_empty() {
                        buf.set_string(inner.x + label_w as u16, y, &id_text, id_style);
                    }
                    if !suffix_text.is_empty() {
                        buf.set_string(
                            inner.x + (label_w + id_w) as u16,
                            y,
                            &suffix_text,
                            suffix_style,
                        );
                    }
                    // Fill remaining with spaces
                    if pad > 0 {
                        buf.set_string(
                            inner.x + (label_w + id_w + suffix_w) as u16,
                            y,
                            &" ".repeat(pad),
                            Style::default(),
                        );
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn item_style(item_type: &ItemType, colors: &crate::config::Colors) -> Style {
    let s = match item_type {
        ItemType::Tab => &colors.tab,
        ItemType::Pane => &colors.pane,
        ItemType::New => &colors.new,
        ItemType::Header => return Style::default().add_modifier(Modifier::DIM),
        ItemType::Blank => return Style::default(),
    };
    style_to_ratatui(s)
}

fn style_to_ratatui(s: &crate::config::Style) -> Style {
    let mut style = Style::default();
    if let Some(fg) = &s.fg {
        if let Some(c) = parse_color(Some(fg)) {
            style = style.fg(c);
        }
    }
    if let Some(bg) = &s.bg {
        if let Some(c) = parse_color(Some(bg)) {
            style = style.bg(c);
        }
    }
    if s.bold {
        style = style.add_modifier(Modifier::BOLD);
    }
    if s.italic {
        style = style.add_modifier(Modifier::ITALIC);
    }
    if s.dim {
        style = style.add_modifier(Modifier::DIM);
    }
    style
}

pub fn parse_color(color: Option<&str>) -> Option<Color> {
    let color = color?;
    match color {
        "black" => Some(Color::Black),
        "red" => Some(Color::Red),
        "green" => Some(Color::Green),
        "yellow" => Some(Color::Yellow),
        "blue" => Some(Color::Blue),
        "magenta" => Some(Color::Magenta),
        "cyan" => Some(Color::Cyan),
        "white" => Some(Color::White),
        "bright black" => Some(Color::DarkGray),
        "bright red" => Some(Color::LightRed),
        "bright green" => Some(Color::LightGreen),
        "bright yellow" => Some(Color::LightYellow),
        "bright blue" => Some(Color::LightBlue),
        "bright magenta" => Some(Color::LightMagenta),
        "bright cyan" => Some(Color::LightCyan),
        "bright white" | "white bright" => Some(Color::Gray),
        s if s.starts_with('#') && s.len() == 7 => {
            let r = u8::from_str_radix(&s[1..3], 16).ok()?;
            let g = u8::from_str_radix(&s[3..5], 16).ok()?;
            let b = u8::from_str_radix(&s[5..7], 16).ok()?;
            Some(Color::Rgb(r, g, b))
        }
        _ => None,
    }
}

fn visible_width(s: &str) -> usize {
    // Strip nerd font chars that might be wider — for now just count chars
    // excluding ANSI sequences
    unicode_width::UnicodeWidthStr::width(s)
}

fn truncate_str(s: &str, max_width: usize) -> String {
    use unicode_width::UnicodeWidthChar;
    let mut width = 0;
    let mut result = String::new();
    for ch in s.chars() {
        let cw = ch.width().unwrap_or(0);
        if width + cw > max_width {
            break;
        }
        result.push(ch);
        width += cw;
    }
    result
}
