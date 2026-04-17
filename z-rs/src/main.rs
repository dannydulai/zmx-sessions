mod config;
mod moox;
mod picker_action;
mod ui;

use config::{display_name, pane_display, pane_name, resolve_dir, Config, LayoutPane, LayoutTab};
use moox::{
    get_kitty_tab_title, kitty_attach_moox, kitty_attach_moox_in_new_tab,
    kitty_attach_moox_in_tab, kitty_launch_moox, list_sessions, moox_attach, panes_for_tab,
    running_pane_icon, running_pane_suffix, set_kitty_tab_title, set_kitty_window_title,
    unique_tabs,
};
use picker_action::PickerAction;
use ui::app::{DirNeeds, PickerData, PickerResult};
use ui::panel::{ItemType, PanelItem};

use std::collections::HashMap;
use std::path::Path;
use std::process;

// Nerd font icons
const I_NEW: &str = "\u{f067}";
const I_TAB: &str = "\u{eea8}";
const I_PANE: &str = "\u{f489}";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if which("moox").is_none() {
        eprintln!("Error: moox not found in PATH");
        process::exit(1);
    }

    config::ensure_config_dir();
    let config = config::load_config();

    if args.is_empty() || args[0] == "help" || args[0] == "--help" {
        print_help();
        return;
    }

    match args[0].as_str() {
        "new" => handle_new(&args[1..], &config),
        "ls" | "l" => handle_ls(&args[1..], &config),
        _ => {
            eprintln!("Unknown command: {}", args[0]);
            print_help();
            process::exit(1);
        }
    }
}

// ---------------------------------------------------------------------------
// z new
// ---------------------------------------------------------------------------

fn handle_new(args: &[String], config: &Config) {
    if args.first().map(|s| s.as_str()) == Some("pane") {
        let tab_name = get_kitty_tab_title();
        if let Some(tab_name) = tab_name {
            if let Some(what) = args.get(1).map(|s| s.as_str()) {
                let action = action_from_cli(what, Some(&tab_name));
                execute_picker_action(action, None, config);
            }
            picker_new_pane(&tab_name, config);
        } else {
            if let Some(what) = args.get(1).map(|s| s.as_str()) {
                let action = action_from_cli(what, None);
                execute_picker_action(action, None, config);
            }
            picker_new(config);
        }
        return;
    }

    if let Some(what) = args.first().map(|s| s.as_str()) {
        let action = action_from_cli(what, None);
        execute_picker_action(action, None, config);
    }

    if let Some(tab_name) = get_kitty_tab_title() {
        picker_new_pane(&tab_name, config);
    } else {
        picker_new(config);
    }
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

fn execute_picker_action(action: PickerAction, picker_dir: Option<&str>, config: &Config) {
    let tabs = load_validated_tabs();

    match action {
        PickerAction::CreateDefaultTabShell => {
            let dir = picker_dir
                .map(|d| d.to_string())
                .unwrap_or_else(|| {
                    std::env::current_dir()
                        .unwrap_or_default()
                        .display()
                        .to_string()
                });
            let tab_name = basename(&dir);
            let pn = config.default.name.as_deref().unwrap_or("Shell");
            set_kitty_tab_title(&tab_name);
            attach_and_exit(
                None,
                config.default.cmd.as_deref(),
                Some(&dir),
                Some(vars(&tab_name, pn)),
                config.default.name.as_deref(),
            );
        }
        PickerAction::CreateDefaultPaneShell { tab_name } => {
            let pn = config.default.name.as_deref().unwrap_or("Shell");
            attach_and_exit(
                None,
                config.default.cmd.as_deref(),
                picker_dir,
                Some(vars(&tab_name, pn)),
                config.default.name.as_deref(),
            );
        }
        PickerAction::CreateNamedTab { tab_name } => {
            set_kitty_tab_title(&tab_name);
            attach_and_exit(None, None, None, Some(vars(&tab_name, "Shell")), None);
        }
        PickerAction::CreateNamedPane { tab_name, pane_name } => {
            attach_and_exit(None, None, None, Some(vars(&tab_name, &pane_name)), None);
        }
        PickerAction::OpenLayoutTab { tab_name } => {
            let tab = find_layout_tab(&tabs, &tab_name);
            let dir = resolve_picker_dir(picker_dir, tab.dir.as_deref());
            let tab_name_resolved = basename(&dir);
            set_kitty_tab_title(&tab_name_resolved);

            for i in 1..tab.panes.len() {
                let p = &tab.panes[i];
                let pdir = pane_dir(p, &dir);
                kitty_launch_moox(
                    p.cmd.as_deref(),
                    Some(&pdir),
                    Some(&vars(&tab_name_resolved, &pane_name(p))),
                );
            }
            if !tab.panes.is_empty() {
                let p = &tab.panes[0];
                let pdir = pane_dir(p, &dir);
                let wt = if p.name.is_empty() {
                    None
                } else {
                    Some(p.name.as_str())
                };
                attach_and_exit(
                    None,
                    p.cmd.as_deref(),
                    Some(&pdir),
                    Some(vars(&tab_name_resolved, &pane_name(p))),
                    wt,
                );
            }
        }
        PickerAction::OpenLayoutPane {
            tab_name,
            pane_name: pane_name_opt,
        } => {
            let name = if let Some(pane_name) = pane_name_opt {
                format!("{}.{}", tab_name, pane_name)
            } else {
                tab_name
            };
            let (pane, tab) = find_layout_pane(&tabs, &name);
            let dir = resolve_picker_dir(picker_dir, pane.dir.as_deref().or(tab.dir.as_deref()));
            let wt = if pane.name.is_empty() {
                None
            } else {
                Some(pane.name.as_str())
            };
            attach_and_exit(
                None,
                pane.cmd.as_deref(),
                Some(&dir),
                Some(vars(&tab.name, &pane_name(pane))),
                wt,
            );
        }
        PickerAction::OpenExistingTab { tab_name } => {
            let sessions = list_sessions();
            let tab_sessions = panes_for_tab(&sessions, &tab_name);
            if tab_sessions.is_empty() {
                eprintln!("No running sessions in tab: {}", tab_name);
                process::exit(1);
            }
            for i in 1..tab_sessions.len() {
                let s = tab_sessions[i];
                let wt = if s.pane.is_empty() {
                    None
                } else {
                    Some(s.pane.as_str())
                };
                kitty_attach_moox(&s.id, wt);
            }
            let s = tab_sessions[0];
            let wt = if s.pane.is_empty() {
                None
            } else {
                Some(s.pane.as_str())
            };
            attach_and_exit(Some(&s.id), None, None, None, wt);
        }
        PickerAction::OpenExistingPane {
            session_id,
            pane_title,
        } => {
            attach_and_exit(Some(&session_id), None, None, None, pane_title.as_deref());
        }
        PickerAction::OpenAllRunningTabs => {
            open_all_running_tabs_and_exit();
        }
        PickerAction::RawShell => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            let status = std::process::Command::new(&shell)
                .status()
                .map(|s| s.code().unwrap_or(1))
                .unwrap_or(1);
            process::exit(status);
        }
    }
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

fn build_picker_new_data(_config: &Config) -> PickerData {
    let layout_tabs = load_validated_tabs();
    let sessions = list_sessions();

    let mut layout_items = Vec::new();
    layout_items.push(PanelItem::blank());
    layout_items.push(PanelItem {
        label: format!("{} New Shell...", I_NEW),
        action: Some(PickerAction::CreateDefaultTabShell),
        selectable: true,
        indent: 0,
        item_type: ItemType::New,
        suffix: None,
        id: None,
    });

    for tab in &layout_tabs {
        layout_items.push(PanelItem::blank());
        layout_items.push(PanelItem {
            label: format!("{} {}", I_TAB, display_name(&tab.name)),
            action: Some(PickerAction::OpenLayoutTab {
                tab_name: tab.name.clone(),
            }),
            selectable: true,
            indent: 0,
            item_type: ItemType::Tab,
            suffix: None,
            id: None,
        });
        for pane in &tab.panes {
            layout_items.push(PanelItem {
                label: format!("{} {}", I_PANE, display_name(&pane_display(pane))),
                action: Some(PickerAction::OpenLayoutPane {
                    tab_name: tab.name.clone(),
                    pane_name: Some(pane.name.clone()),
                }),
                selectable: true,
                indent: 1,
                item_type: ItemType::Pane,
                suffix: None,
                id: None,
            });
        }
    }
    layout_items.push(PanelItem::blank());
    layout_items.push(PanelItem {
        label: format!("{} Raw Shell", I_NEW),
        action: Some(PickerAction::RawShell),
        selectable: true,
        indent: 0,
        item_type: ItemType::New,
        suffix: None,
        id: None,
    });

    let mut running_items = Vec::new();
    let tabs = unique_tabs(&sessions);
    for tab_name in &tabs {
        let tab_panes = panes_for_tab(&sessions, tab_name);
        running_items.push(PanelItem::blank());
        running_items.push(PanelItem {
            label: format!("{} {}", I_TAB, display_name(tab_name)),
            action: Some(PickerAction::OpenExistingTab {
                tab_name: tab_name.clone(),
            }),
            selectable: true,
            indent: 0,
            item_type: ItemType::Tab,
            suffix: None,
            id: None,
        });
        for s in &tab_panes {
            running_items.push(PanelItem {
                label: format!("{} {}", running_pane_icon(s), display_name(&s.pane)),
                action: Some(PickerAction::OpenExistingPane {
                    session_id: s.id.clone(),
                    pane_title: if s.pane.is_empty() {
                        None
                    } else {
                        Some(s.pane.clone())
                    },
                }),
                selectable: true,
                indent: 1,
                item_type: ItemType::Pane,
                suffix: Some(running_pane_suffix(s)),
                id: None,
            });
        }
    }
    if !tabs.is_empty() {
        running_items.push(PanelItem::blank());
        running_items.push(PanelItem {
            label: format!("{} Open all tabs", I_NEW),
            action: Some(PickerAction::OpenAllRunningTabs),
            selectable: true,
            indent: 0,
            item_type: ItemType::New,
            suffix: None,
            id: None,
        });
    }

    PickerData {
        layout_items,
        running_items,
        left_title: None,
    }
}

fn build_picker_pane_data(tab_name: &str, _config: &Config) -> PickerData {
    let layout_tabs = load_validated_tabs();
    let sessions = list_sessions();

    let mut layout_items = Vec::new();
    layout_items.push(PanelItem::blank());
    layout_items.push(PanelItem {
        label: format!("{} New Shell", I_NEW),
        action: Some(PickerAction::CreateDefaultPaneShell {
            tab_name: tab_name.to_string(),
        }),
        selectable: true,
        indent: 0,
        item_type: ItemType::New,
        suffix: None,
        id: None,
    });

    for tab in &layout_tabs {
        layout_items.push(PanelItem::blank());
        layout_items.push(PanelItem {
            label: format!("{} {}", I_TAB, display_name(&tab.name)),
            action: Some(PickerAction::OpenLayoutTab {
                tab_name: tab.name.clone(),
            }),
            selectable: true,
            indent: 0,
            item_type: ItemType::Tab,
            suffix: None,
            id: None,
        });
        for pane in &tab.panes {
            layout_items.push(PanelItem {
                label: format!("{} {}", I_PANE, display_name(&pane_display(pane))),
                action: Some(PickerAction::OpenLayoutPane {
                    tab_name: tab.name.clone(),
                    pane_name: Some(pane.name.clone()),
                }),
                selectable: true,
                indent: 1,
                item_type: ItemType::Pane,
                suffix: None,
                id: None,
            });
        }
    }
    layout_items.push(PanelItem::blank());
    layout_items.push(PanelItem {
        label: format!("{} Raw Shell", I_NEW),
        action: Some(PickerAction::RawShell),
        selectable: true,
        indent: 0,
        item_type: ItemType::New,
        suffix: None,
        id: None,
    });

    let mut running_items = Vec::new();
    // Sort current tab first
    let mut sorted_sessions = sessions.clone();
    sorted_sessions.sort_by(|a, b| {
        let am = if a.tab == tab_name { 0 } else { 1 };
        let bm = if b.tab == tab_name { 0 } else { 1 };
        am.cmp(&bm)
    });

    let mut seen_tabs = std::collections::HashSet::new();
    for s in &sorted_sessions {
        if seen_tabs.insert(s.tab.clone()) {
            running_items.push(PanelItem::blank());
            running_items.push(PanelItem {
                label: format!("{} {}", I_TAB, display_name(&s.tab)),
                action: None,
                selectable: false,
                indent: 0,
                item_type: ItemType::Tab,
                suffix: None,
                id: None,
            });
        }
        running_items.push(PanelItem {
            label: format!("{} {}", running_pane_icon(s), display_name(&s.pane)),
            action: Some(PickerAction::OpenExistingPane {
                session_id: s.id.clone(),
                pane_title: if s.pane.is_empty() {
                    None
                } else {
                    Some(s.pane.clone())
                },
            }),
            selectable: true,
            indent: 1,
            item_type: ItemType::Pane,
            suffix: Some(running_pane_suffix(s)),
            id: None,
        });
    }

    PickerData {
        layout_items,
        running_items,
        left_title: Some(display_name(tab_name)),
    }
}

fn picker_new(config: &Config) {
    let config = config.clone();
    let config_for_closure = config.clone();
    let result = run_picker(move || build_picker_new_data(&config_for_closure), &config);

    if let Some(action) = result.action {
        execute_picker_action(action, result.dir.as_deref(), &config);
    }
}

fn open_all_running_tabs_and_exit() {
    let sessions = list_sessions();
    let tabs = unique_tabs(&sessions);

    for tab_name in &tabs {
        let tab_sessions = panes_for_tab(&sessions, tab_name);
        if tab_sessions.is_empty() {
            continue;
        }

        let first = tab_sessions[0];
        let first_title = if first.pane.is_empty() {
            None
        } else {
            Some(first.pane.as_str())
        };
        let tab_title = display_name(tab_name);
        kitty_attach_moox_in_new_tab(&first.id, &tab_title, first_title);

        for s in tab_sessions.iter().skip(1) {
            let wt = if s.pane.is_empty() {
                None
            } else {
                Some(s.pane.as_str())
            };
            kitty_attach_moox_in_tab(&s.id, "recent:0", wt);
        }
    }

    process::exit(0);
}

fn picker_new_pane(tab_name: &str, config: &Config) {
    let config = config.clone();
    let config_for_closure = config.clone();
    let tab_name_owned = tab_name.to_string();
    let tab_name_for_closure = tab_name_owned.clone();
    let result = run_picker(
        move || build_picker_pane_data(&tab_name_for_closure, &config_for_closure),
        &config,
    );

    if let Some(action) = result.action {
        execute_picker_action(action, result.dir.as_deref(), &config);
    }
}

fn run_picker<F: Fn() -> PickerData + 'static>(build_data: F, config: &Config) -> PickerResult {
    use crossterm::{
        execute,
        terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    };
    use ratatui::backend::CrosstermBackend;
    use ratatui::Terminal;

    enable_raw_mode().unwrap();
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen, crossterm::cursor::Hide).unwrap();
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).unwrap();

    let data = build_data();
    let colors = config.colors.clone();

    let config_for_dir = config.clone();
    let needs_dir = move |action: &PickerAction| -> Option<DirNeeds> {
        action_needs_dir(action, &config_for_dir)
    };

    let mut app = ui::app::App::new(data, colors, Box::new(needs_dir), Box::new(build_data));

    loop {
        terminal.draw(|f| app.render(f)).unwrap();
        if app.should_quit() {
            break;
        }

        let timeout = std::time::Duration::from_millis(if app.kill_poll_ids.is_some() {
            100
        } else {
            250
        });

        if crossterm::event::poll(timeout).unwrap_or(false) {
            if let Ok(ev) = crossterm::event::read() {
                app.handle_event(ev);
            }
        } else if app.kill_poll_ids.is_some() {
            app.tick();
        }
    }

    let result = app.into_result();

    disable_raw_mode().unwrap();
    execute!(
        std::io::stdout(),
        LeaveAlternateScreen,
        crossterm::cursor::Show
    )
    .unwrap();

    result
}

// ---------------------------------------------------------------------------
// z ls
// ---------------------------------------------------------------------------

fn handle_ls(args: &[String], config: &Config) {
    let what = args.first().map(|s| s.as_str()).unwrap_or("");

    match what {
        "layouts" => {
            let tabs = config::load_tabs();
            if tabs.is_empty() {
                println!("No layouts defined.");
                return;
            }
            for tab in &tabs {
                let dir = tab.dir.as_deref().unwrap_or("");
                if dir.is_empty() {
                    println!("{}", tab.name);
                } else {
                    println!("{} ({})", tab.name, dir);
                }
                for pane in &tab.panes {
                    let cmd = pane
                        .cmd
                        .as_deref()
                        .or(config.default.cmd.as_deref())
                        .unwrap_or("$SHELL");
                    println!("  {} \u{2192} {}", pane.name, cmd);
                }
            }
        }
        "tabs" => {
            let sessions = list_sessions();
            let tabs = unique_tabs(&sessions);
            if tabs.is_empty() {
                println!("No running tabs.");
                return;
            }
            for tab_name in &tabs {
                let panes = panes_for_tab(&sessions, tab_name);
                let pane_names: Vec<&str> = panes.iter().map(|p| p.pane.as_str()).collect();
                println!("{} ({})", tab_name, pane_names.join(", "));
            }
        }
        "panes" => {
            let sessions = list_sessions();
            if sessions.is_empty() {
                println!("No running panes.");
                return;
            }
            for s in &sessions {
                println!("{}  {}/{}", s.id, s.tab, s.pane);
            }
        }
        "" => {
            eprintln!("Usage: z ls <layouts|tabs|panes>");
            process::exit(1);
        }
        _ => {
            eprintln!("Unknown: {}. Use: layouts, tabs, panes", what);
            process::exit(1);
        }
    }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

fn print_help() {
    let config_display = if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        format!("{}/z", xdg)
    } else {
        "~/.config/z".to_string()
    };

    println!(
        r#"z — terminal workspace manager backed by moox

Usage:
  z new [what]           Create a new tab or open existing
  z new pane [what]      Create a pane in the current tab
  z ls layouts           List configured layouts
  z ls tabs              List running tabs
  z ls panes             List running panes
  z help                 Show this help

What specifiers:
  new:<name>             Create new tab with given name
  layout-tab:<name>      Start all panes from a layout tab
  layout-pane:<tab>.<pane>  Start a specific layout pane
  existing-tab:<name>    Open all panes of a running tab
  existing-pane:<id>     Attach to a specific running pane

Without a specifier, an interactive picker is shown.

Config: {}/
  config.yaml            Default pane settings and colors
  layouts.yaml           Layout tab definitions
  layouts.d/*.yaml       Additional layout files"#,
        config_display
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_what(what: &str) -> (&str, &str) {
    if let Some(colon) = what.find(':') {
        (&what[..colon], &what[colon + 1..])
    } else {
        ("new", what)
    }
}

fn action_from_cli(what: &str, current_tab: Option<&str>) -> PickerAction {
    let (kind, name) = parse_what(what);
    match kind {
        "new" => {
            if let Some(tab_name) = current_tab {
                PickerAction::CreateNamedPane {
                    tab_name: tab_name.to_string(),
                    pane_name: name.to_string(),
                }
            } else {
                PickerAction::CreateNamedTab {
                    tab_name: name.to_string(),
                }
            }
        }
        "layout-tab" => PickerAction::OpenLayoutTab {
            tab_name: name.to_string(),
        },
        "layout-pane" => {
            let dot = name.find('.').unwrap_or(name.len());
            let tab_name = name[..dot].to_string();
            let pane_name = if dot < name.len() {
                Some(name[dot + 1..].to_string())
            } else {
                None
            };
            PickerAction::OpenLayoutPane { tab_name, pane_name }
        }
        "existing-tab" => PickerAction::OpenExistingTab {
            tab_name: name.to_string(),
        },
        "existing-pane" => {
            let pane_title = list_sessions()
                .into_iter()
                .find(|s| s.id == name)
                .and_then(|s| if s.pane.is_empty() { None } else { Some(s.pane) });
            PickerAction::OpenExistingPane {
                session_id: name.to_string(),
                pane_title,
            }
        }
        "new-shell" => current_tab
            .map(|tab_name| PickerAction::CreateDefaultPaneShell {
                tab_name: tab_name.to_string(),
            })
            .unwrap_or(PickerAction::CreateDefaultTabShell),
        "shell" => PickerAction::RawShell,
        "open-all-tabs" => PickerAction::OpenAllRunningTabs,
        _ => {
            eprintln!("Invalid target: {}", what);
            process::exit(1);
        }
    }
}

fn find_layout_tab<'a>(tabs: &'a [LayoutTab], name: &str) -> &'a LayoutTab {
    tabs.iter().find(|t| t.name == name).unwrap_or_else(|| {
        eprintln!("Tab not found: {}", name);
        process::exit(1);
    })
}

fn find_layout_pane<'a>(tabs: &'a [LayoutTab], name: &str) -> (&'a LayoutPane, &'a LayoutTab) {
    let dot = name.find('.').unwrap_or(name.len());
    let tab_name = &name[..dot];
    let pane_name = if dot < name.len() {
        &name[dot + 1..]
    } else {
        ""
    };

    let tab = find_layout_tab(tabs, tab_name);
    let pane = if pane_name.is_empty() {
        tab.panes.first()
    } else {
        tab.panes.iter().find(|p| p.name == pane_name)
    };
    let pane = pane.unwrap_or_else(|| {
        eprintln!("Pane not found: {}", pane_name);
        process::exit(1);
    });
    (pane, tab)
}

fn load_validated_tabs() -> Vec<LayoutTab> {
    let tabs = config::load_tabs();
    let errors = config::validate_tabs(&tabs);
    if !errors.is_empty() {
        for e in &errors {
            eprintln!("\x1b[91mError: {}\x1b[0m", e);
        }
        eprintln!("\nFix your layout config and try again.");
        process::exit(1);
    }
    tabs
}

fn attach_and_exit(
    id: Option<&str>,
    command: Option<&str>,
    dir: Option<&str>,
    vars: Option<HashMap<String, String>>,
    window_title: Option<&str>,
) {
    if let Some(title) = window_title {
        set_kitty_window_title(&display_name(title));
    }
    let exit_code = moox_attach(id, command, dir, vars.as_ref());
    process::exit(exit_code);
}

fn vars(tab: &str, pane: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    m.insert("tab".to_string(), tab.to_string());
    m.insert("pane".to_string(), pane.to_string());
    m
}

fn resolve_picker_dir(picker_dir: Option<&str>, config_dir: Option<&str>) -> String {
    if let Some(d) = picker_dir {
        return d.to_string();
    }
    if let Some(d) = config_dir {
        if d != "ask" {
            return resolve_dir(d);
        }
    }
    std::env::current_dir()
        .unwrap_or_default()
        .display()
        .to_string()
}

fn pane_dir(p: &LayoutPane, tab_dir: &str) -> String {
    match &p.dir {
        Some(d) if d != "ask" => resolve_dir(d),
        _ => tab_dir.to_string(),
    }
}

fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

fn action_needs_dir(action: &PickerAction, config: &Config) -> Option<DirNeeds> {
    let tabs = config::load_tabs(); // Re-load is fine for this check
    match action {
        PickerAction::CreateDefaultTabShell | PickerAction::CreateDefaultPaneShell { .. } => {
            return check_dir_needs_input(config.default.dir.as_deref());
        }
        PickerAction::OpenLayoutTab { tab_name } => {
            if let Some(tab) = tabs.iter().find(|t| t.name == *tab_name) {
                return check_dir_needs_input(tab.dir.as_deref());
            }
        }
        PickerAction::OpenLayoutPane { tab_name, pane_name } => {
            if let Some(tab) = tabs.iter().find(|t| t.name == *tab_name) {
                let pane = if let Some(pane_name) = pane_name {
                    tab.panes.iter().find(|p| p.name == *pane_name)
                } else {
                    tab.panes.first()
                };
                let dir = pane.and_then(|p| p.dir.as_deref()).or(tab.dir.as_deref());
                return check_dir_needs_input(dir);
            }
        }
        _ => {}
    }
    None
}

fn check_dir_needs_input(dir: Option<&str>) -> Option<DirNeeds> {
    let dir = dir?;
    if dir == "ask" {
        return Some(DirNeeds {
            initial: std::env::current_dir()
                .unwrap_or_default()
                .display()
                .to_string(),
        });
    }
    let resolved = resolve_dir(dir);
    if Path::new(&resolved).is_dir() {
        return None;
    }
    Some(DirNeeds { initial: resolved })
}

fn which(cmd: &str) -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(cmd))
            .find(|p| p.is_file())
    })
}
