# z — Architecture

## Overview

`z` is a Rust terminal workspace manager built around three main pieces:

- **moox** for persistent shell sessions
- **kitty** for tab and window orchestration
- **ratatui + crossterm** for the interactive picker UI

The project is intentionally opinionated. It does not try to abstract over all terminals or become a full terminal multiplexer. It focuses on making persistent kitty-based workspaces fast to launch, reopen, preview, and manage.

## Current file structure

```text
.
├── src/
│   ├── main.rs
│   ├── config.rs
│   ├── moox.rs
│   ├── picker_action.rs
│   └── ui/
│       ├── app.rs
│       ├── dir_input.rs
│       ├── mod.rs
│       └── panel.rs
├── Cargo.toml
├── README.md
├── SPEC.md
└── ARCHITECTURE.md
```

## Top-level responsibilities

### `src/main.rs`

Owns the CLI surface and high-level orchestration.

Responsibilities:

- parse `z new`, `z new pane`, `z ls tabs`, and `z ls panes`
- decide whether to open the full picker or the pane picker based on kitty context
- build picker data from layouts and running sessions
- execute the selected `PickerAction`
- print help and non-TUI list output

### `src/config.rs`

Owns config loading and layout validation.

Responsibilities:

- load `config.yaml`
- load `layouts.yaml` and `layouts.d/*.yaml`
- validate layout tabs and panes
- normalize display names, pane names, colors, and directories

### `src/moox.rs`

Owns integration with external commands.

Responsibilities:

- list moox sessions
- fetch pane history with `moox history --vt`
- parse ANSI-styled history into ratatui lines
- attach to moox sessions
- kill sessions
- launch or attach panes through kitty remote control
- inspect kitty tab context and set kitty titles

### `src/picker_action.rs`

Defines the typed action model used by the picker and execution layer.

```rust
pub enum PickerAction {
    CreateDefaultTabShell,
    CreateDefaultPaneShell { tab_name: String },
    OpenLayoutTab { tab_name: String },
    OpenLayoutPane { tab_name: String, pane_name: Option<String> },
    OpenExistingTab { tab_name: String },
    OpenExistingPane { session_id: String, pane_title: Option<String> },
    OpenAllRunningTabs,
    RawShell,
}
```

The picker carries typed actions directly, which keeps selection, preview, kill handling, and execution aligned on one shared action model.

### `src/ui/app.rs`

Owns the TUI state machine.

Responsibilities:

- manage panel focus and selection
- manage overlay state
- manage preview loading and scrolling
- handle all keyboard input
- return `PickerResult { action, dir }`

### `src/ui/panel.rs`

Owns the scrollable list widget used for the layouts and running columns.

Responsibilities:

- selection movement
- scroll offset management
- item rendering and styling
- focused vs unfocused selected-row rendering

### `src/ui/dir_input.rs`

Owns the directory chooser overlay.

Responsibilities:

- path editing
- subdirectory browsing
- fuzzy filtering
- submit and cancel behavior

## Data flow

```text
User input
    |
    v
main.rs
    |
    +-- parse CLI command
    |
    +-- build picker data from config + moox session list
    |
    v
ui/app.rs
    |
    +-- handle keyboard input
    +-- move selection / focus
    +-- load running-pane preview
    +-- collect directory input when needed
    |
    v
PickerResult { action, dir }
    |
    v
main.rs
    |
    +-- execute_picker_action(action, dir, config)
    |
    v
moox.rs
    |
    +-- moox CLI
    +-- kitty remote control
```

## Picker model

The picker is built from typed items rather than stringly-typed values.

`PanelItem` carries an optional `PickerAction`:

- layout items map to layout-opening actions
- running pane items map to `OpenExistingPane`
- running tab items map to `OpenExistingTab`
- static headers and separators are non-actionable

This makes three things simpler:

- the UI no longer has to parse action strings
- preview and kill behavior can match directly on action variants
- the execution path is centralized in one dispatcher

## Picker columns

### Layouts column

Built from validated layout config and a few synthetic actions:

- `New Shell...`
- layout tabs
- layout panes
- `Raw Shell`

### Running column

Built from `moox list -j` and grouped by the `tab` session var:

- running tabs
- running panes under each tab
- `Open all tabs` when running tabs exist

### Preview column

Built only for selected running panes.

The preview stores:

- ANSI-parsed `Vec<Line<'static>>`
- vertical scroll
- horizontal scroll
- currently loaded session ID
- pane name
- viewport height
- bottom-follow state

The preview is not a terminal emulator. It assumes normal colored history output and ignores richer screen-state semantics.

## Focus and input model

`App::handle_key()` is the single input entry point.

This is deliberate:

- one place handles panel navigation
- one place handles overlay interaction
- one place handles preview scrolling
- one place handles selection and kill confirmation

Focus cycles through:

- Layouts
- Running
- Preview

The preview only becomes focusable when a running pane is selected and preview content exists.

## Refresh behavior

`Ctrl+L` rebuilds picker data and refreshes preview content.

Important details:

- selected panel cursor positions are preserved when possible
- preview scroll position is preserved when possible
- bottom-follow mode is preserved
- if refreshed preview content becomes shorter, scroll is clamped to the new bounds

## Launch behavior

The execution layer lives in `execute_picker_action(...)` in `main.rs`.

### Default shell actions

- `CreateDefaultTabShell` starts a new shell using config defaults and sets the kitty tab title
- `CreateDefaultPaneShell` starts a new shell inside the current tab context

### Layout actions

- `OpenLayoutTab` launches all panes from the layout
- `OpenLayoutPane` launches only one pane from the layout

When opening a full layout tab:

- panes after the first are launched through kitty first
- the first pane then attaches in the current process and exits the picker process

### Running-session actions

- `OpenExistingPane` attaches directly to a moox session ID
- `OpenExistingTab` reopens all panes in a running tab
- `OpenAllRunningTabs` reopens each running tab in its own kitty tab

## Directory selection model

Some actions require a directory chooser before execution.

`action_needs_dir(...)` in `main.rs` decides this by inspecting:

- default shell config
- layout tab directory
- layout pane directory override

If an action needs a directory and the configured value is `ask`, the picker opens `DirInputState` before returning.

## moox integration details

z uses moox session vars as the main identity layer.

Important conventions:

- sessions are created unnamed
- `tab` and `pane` vars define workspace structure
- running tabs are discovered by grouping sessions on `tab`
- pane reopen actions attach by session ID
- preview content comes from `moox history --vt <id>`

## kitty integration details

z depends on kitty remote control for workspace orchestration.

Used capabilities include:

- `kitty @ ls --self` to detect current tab context
- setting tab titles
- setting window titles
- launching extra panes in the current or new kitty tab

This keeps `z` lightweight: moox provides persistence, kitty provides window management, and z coordinates between them.

## Typed action model

The picker uses typed actions throughout the UI and execution path. This keeps the architecture simpler because it:

- avoids string parsing in the UI layer
- reduces invalid intermediate states
- makes preview logic and kill logic more direct
- keeps picker selection and action execution on the same model

## Operational notes

- build with `cargo build --release`
- the release binary is `target/release/z`
- config lives in `~/.config/z/`
- the project root is the repository root, not a nested `z-rs/` directory
