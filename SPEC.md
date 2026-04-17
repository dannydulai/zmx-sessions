# z — Terminal Workspace Manager

`z` is a terminal workspace manager built around [moox](https://github.com/dannydulai/moox) and [kitty](https://sw.kovidgoyal.net/kitty/). It gives you a fast interactive picker for launching new shells, opening saved layouts, reconnecting to running panes, and browsing persistent terminal workspaces without switching to a full terminal multiplexer workflow.

## Concepts

- **Tab**: A logical workspace. In practice this maps to a kitty tab and is tracked with the moox session variable `tab=<name>`.
- **Pane**: A persistent shell inside a tab. In practice this maps to a kitty window and is tracked with the moox session variable `pane=<name>`.
- **Layout**: A configured workspace template defined in YAML. A layout tab can define multiple panes, commands, and directories.
- **Running session**: An existing moox session that can be reopened from the picker.
- **Session ID**: The moox-generated ID used to reconnect to a specific pane.

## Commands

```text
z new                  Open the interactive picker
z new pane             Open the interactive picker in the current tab
z ls tabs              List running tabs
z ls panes             List running panes
z help                 Show help
```

## Picker behavior

`z new` and `z new pane` are picker-driven. There are no direct `[what]` CLI variants anymore.

When `z new` runs, z checks the current kitty context with `kitty @ ls --self`:

- if the current kitty tab has an overridden title, z treats that title as the current tab context and opens the pane-oriented picker
- otherwise, z opens the full workspace picker

`z new pane` always opens the pane-oriented picker when tab context is available, and falls back to the full picker otherwise.

## Main picker layout

The main picker uses up to three columns:

- **Layouts**: new shell actions and configured layout tabs/panes
- **Running**: currently running tabs and panes discovered from moox
- **Preview**: inline history for the selected running pane

If there are no running sessions, the picker shows only the left column.

## Main picker contents

### Layouts column

The left column includes:

- a `New Shell...` action
- configured layout tabs
- individual panes within each layout tab
- a `Raw Shell` action

### Running column

The running column includes:

- running tabs grouped by `tab` session var
- running panes nested under each tab
- an `Open all tabs` action at the bottom when running tabs exist

The unfocused running selection stays visible for pane rows so the preview stays visually tied to the selected pane.

### Preview column

The preview column shows `moox history --vt <session>` for the selected running pane.

ANSI color is preserved and rendered inside the TUI. The preview is intended for normal colorized shell history, not full terminal emulation.

The preview starts pegged to the bottom. You can scroll upward normally, and the visible viewport is clamped so the pane does not leave empty blank space at the bottom.

## Keybindings

| Key | Action |
|---|---|
| `j` / `k`, Up / Down | Move selection, or scroll preview when preview is focused |
| `h` / `l`, Left / Right | Horizontal preview scroll when preview is focused |
| `Tab` | Cycle focus forward through Layouts, Running, Preview |
| `Shift+Tab` | Cycle focus backward |
| `g`, `0` | Jump to top of the active panel, or top-left of preview |
| `G`, `$` | Jump to bottom of the active panel, or bottom of preview |
| `Enter` | Select the current item |
| `Shift+K` | Kill the selected running pane or running tab |
| `Ctrl+L` | Refresh picker data and preview content without resetting preview scroll |
| `q`, `Esc`, `Ctrl+C`, `Ctrl+D` | Quit |

## Action semantics

### New shell

`New Shell...` starts a new moox-backed shell using `config.yaml` defaults.

In the main picker it creates a new tab shell. In the pane picker it creates a new pane inside the current tab context.

If the configured directory is `ask`, z opens the directory chooser first.

### Layout tab

Selecting a layout tab launches the full layout:

- pane 1 attaches in the current process
- remaining panes are opened through kitty remote control
- the kitty tab title is set from the resolved directory basename

### Layout pane

Selecting an individual layout pane starts only that pane using the layout’s configured command and directory resolution rules.

### Running pane

Selecting a running pane reattaches directly to that moox session.

### Running tab

Selecting a running tab opens all panes from that tab:

- the first pane attaches in the current process
- remaining panes are reopened through kitty

### Open all tabs

`Open all tabs` reopens every running tab:

- the first pane for each tab is opened in a new kitty tab and used to establish that tab
- the rest of that tab’s panes are opened into the same kitty tab

## Preview behavior

The preview is tied to the selected running pane.

- selecting a different running pane loads that pane’s history
- refreshing preserves horizontal scroll, vertical scroll, and bottom-follow mode when possible
- the preview is cleared when the selected running item is not a pane

## Kill behavior

`Shift+K` opens a confirmation overlay.

- on a pane row, it kills that pane’s moox session
- on a running tab row, it kills every pane in that tab

After confirmation, z polls moox briefly so the UI can refresh as sessions disappear.

## Config directory

z uses:

```text
$XDG_CONFIG_HOME/z/
```

or:

```text
~/.config/z/
```

Files:

| File | Description |
|---|---|
| `config.yaml` | Default shell behavior and colors |
| `layouts.yaml` | Layout tab definitions |
| `layouts.d/*.yaml` | Additional layout files |

## `config.yaml`

```yaml
default:
  dir: ask
  name: SHELL

colors:
  tab: '#ff6060'
  pane: '#ffbbbb'
  new: bright cyan
  running: white
  selection: { bg: "#2a2a4e", fg: "#e0e0e0" }
```

### `default`

| Field | Description |
|---|---|
| `name` | Default pane name and kitty window title |
| `cmd` | Default command to run instead of a login shell |
| `dir` | `ask`, a fixed path, or omitted for current working directory |

### `colors`

The picker supports named colors and hex colors. Layout tabs, panes, new actions, running headers, and the active selection can all be styled through config.

## `layouts.yaml`

```yaml
tabs:
  - name: Claude_+_3
    dir: ask
    panes:
      - name: Claude
        display: Claude AI
        cmd: claude --continue || claude
      - name: Shell_#1
      - name: Shell_#2
      - name: Shell_#3
```

### Layout tab fields

| Field | Description |
|---|---|
| `name` | Required tab identifier |
| `dir` | Shared tab directory or `ask` |
| `panes` | Pane definitions for this layout |

### Layout pane fields

| Field | Description |
|---|---|
| `name` | Pane identifier and kitty window title when set |
| `display` | UI label for the pane |
| `cmd` | Command to run in the pane |
| `dir` | Per-pane directory override |

### Display rules

- displayed tab and pane names replace `_` with spaces
- pane display text prefers `display`, then `name`, then `cmd`, then `Shell`
- pane var naming prefers `name`, then `Shell`

## moox integration

z uses moox as the persistence layer.

Typical commands involved:

```text
moox list -j
moox history --vt <id>
moox kill <id>
moox attach --var tab=<tab> --var pane=<pane> - <shell...>
```

z treats moox session vars as the source of truth for grouping and reopening workspaces.

## kitty integration

z uses kitty remote control to:

- detect current tab context
- set tab and window titles
- launch additional panes in tabs or windows
- reopen running workspaces across multiple tabs

This is intentionally opinionated around kitty so the workflow stays simple and predictable.
