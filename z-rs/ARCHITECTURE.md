# z — Architecture (Rust)

## Overview

z is a terminal workspace manager that orchestrates moox (persistent sessions) and kitty (terminal emulator) to provide tmux-like tab/pane management without taking over window management. Written in Rust, uses ratatui + crossterm for the TUI.

## File Structure

```
z-rs/
  src/
    main.rs           CLI entry point, command routing, picker orchestration
    config.rs         Config + layout YAML parsing, validation, color normalization
    moox.rs           moox CLI interactions, kitty window launching, session helpers
    ui/
      mod.rs           Module declarations
      app.rs           Main TUI state machine (panels, overlays, keyboard handling, event loop)
      panel.rs         Scrollable list panel widget with selection and item rendering
      dir_input.rs     Directory chooser overlay (fuzzy file browser)
  Cargo.toml
  SPEC.md             Full specification (shared with TS version)
  ARCHITECTURE.md     This file
```

## Data Flow

```
User input
    |
    v
main.rs (CLI arg parsing)
    |
    +-- z new / z new pane --> picker flow
    |       |
    |       v
    |   run_picker() in main.rs
    |       - enable raw mode, enter alt screen
    |       - create App with panels + closures
    |       - event loop: poll crossterm events, dispatch to App
    |       - leave alt screen, disable raw mode
    |       |
    |       v
    |   app.rs App struct
    |       - handle_event() / handle_key() dispatches to:
    |         - PanelState (move_up/down/top/bottom, select)
    |         - DirInputState (path editing, fuzzy subdirs)
    |         - KillConfirm overlay (y/n)
    |       - render() draws panels, bottom bar, overlays to Frame
    |       |
    |       v
    |   PickerResult { choice, dir }
    |       |
    |       v
    |   main.rs (exec_new_what / exec_new_pane_what / direct handlers)
    |       |
    |       v
    |   moox.rs (moox_attach / kitty_launch_moox / kitty_attach_moox / moox_kill)
    |       |
    |       v
    |   moox CLI + kitty remote control
    |
    +-- z ls --> handle_ls() (stdout, no TUI)
```

## Key Design Decisions

### No session names

moox sessions are created unnamed (`-` as the name placeholder). Identity comes from moox session variables (`tab=`, `pane=`). The moox-generated hex ID is used for reattaching and display.

### Tab grouping by moox var

Running sessions are grouped into tabs by their `tab` moox variable.

### Kitty tab title as tab context

`kitty @ ls --self` checks for an overridden tab title. If found, z shows the pane picker. If not, the full tab picker.

### Tab name from directory basename

When creating a new tab, the kitty tab title is set to `basename(dir)`, not the layout tab name.

### ratatui immediate-mode rendering

Unlike the Ink/React version which uses retained-mode components, ratatui uses immediate-mode rendering:
- `App` holds all state (panel cursors, overlay state, etc.)
- `render()` draws everything fresh each frame
- `PanelWidget` takes a mutable reference to `PanelState` and renders directly to the `Buffer`
- Overlays render on top using `Clear` widget to erase the background

### Single event handler

All keyboard input flows through `App::handle_key()`. No separate input handlers per widget (unlike the Ink version which had multiple `useInput` hooks). This avoids the double-fire issues that plagued the Ink version.

### Crossterm event loop

The main loop uses `crossterm::event::poll()` with a timeout:
- 250ms normally (responsive but not CPU-hungry)
- 100ms during kill-poll (to update the UI as sessions disappear)

### Commands via std::process::Command

All moox and kitty commands are spawned synchronously via `std::process::Command`. `moox_attach` uses `.status()` (inherits stdio), everything else uses `.output()`.

### Key release filtering

Kitty keyboard protocol sends press + release events. Crossterm exposes `KeyEventKind`. All key handling checks `key.kind == KeyEventKind::Release` and returns early.

## Architecture Differences from TypeScript Version

| Aspect | TypeScript (Ink) | Rust (ratatui) |
|--------|-----------------|----------------|
| Rendering | React retained-mode, Ink manages diffs | Immediate-mode, full redraw each frame |
| Event handling | Multiple `useInput` hooks (caused double-fire) | Single `handle_key` method |
| Overlays | React state + conditional rendering | Enum state (`Overlay::None/DirInput/KillConfirm`) |
| Panel navigation | Imperative refs (`useImperativeHandle`) | Direct method calls on `PanelState` |
| Process spawning | `Bun.spawn()` async | `std::process::Command` sync |
| Stdin cleanup | Manual reset after Ink unmount | crossterm `disable_raw_mode` handles it |
| Binary size | ~50MB (Bun bundled) | ~2.5MB (native) |
| Startup time | ~200ms (Bun init) | ~5ms |

## Color System

Colors in config are stored as `Style` structs (`fg`, `bg`, `bold`, `italic`, `dim`). Named colors are mapped to `ratatui::style::Color` variants. Hex colors use `Color::Rgb(r,g,b)`. The mapping happens in `panel.rs::parse_color()`.

## Things to Know

- `cargo build --release` produces the binary at `target/release/z`
- Config is shared with the TS version — same `~/.config/z/` directory
- `moox list -j` returns JSON. Parsed with `serde_json`.
- `moox attach` requires `-v` flags before the name/id. The `-` placeholder means "unnamed session".
- `kitty @ launch` spawns a new window. `kitty @ ls --self` returns current window/tab info.
- `paneName()` does NOT fall back to `cmd` (cmd can contain flags that break moox arg parsing).
- `paneDisplay()` returns `display || name || cmd || "Shell"` — used only for TUI labels.
- Underscore `_` in names displayed as space via `display_name()`.
- `process::exit()` is called after `moox_attach` returns — z does not loop back to the picker.
- Kill polls `moox list` every 100ms for up to 5 seconds after kill.
- Directory chooser is pinned 2 rows from top, grows downward. Up/Down wrap around.
