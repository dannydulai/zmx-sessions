# z — Terminal Workspace Manager

`z` is a terminal workspace manager backed by [moox](https://github.com/dannydulai/moox). It organizes persistent terminal sessions into **tabs** and **panes**, launches them across [kitty](https://sw.kovidgoyal.net/kitty/) windows, and provides an interactive picker (built with [Ink](https://github.com/vadimdemedes/ink) + React) for navigation.

## Concepts

- **Tab**: A logical group of panes. Maps to a kitty tab. Identified by the moox session variable `tab=<name>`. The kitty tab title is set to the basename of the working directory.
- **Pane**: A single persistent moox session within a tab. Identified by the moox session variable `pane=<name>`. Maps to a kitty window.
- **Layout**: A pre-configured tab template defined in YAML. Specifies pane names, commands, and directories.
- **Session ID**: Each moox session has an auto-generated hex ID (e.g. `e6463ec983130091`). Sessions are unnamed (`-` placeholder) — identity comes from moox vars, not the session name.

## Commands

```
z new [what]           Create a new tab or open existing (interactive picker if no arg)
z new pane [what]      Create a pane in the current kitty tab (interactive picker if no arg)
z ls layouts           List configured layout tabs
z ls tabs              List running tabs
z ls panes             List running panes
z help                 Show help
```

### Tab context detection

Both `z new` and `z new pane` check the kitty tab title via `kitty @ ls --self`. If the current kitty tab has an overridden title (user-set), z uses that as the tab context and shows the pane picker. Otherwise, z shows the full tab picker.

### What specifiers

| Specifier | Description |
|---|---|
| `new:<name>` | Create new tab with given name |
| `layout-tab:<name>` | Start all panes from a layout tab |
| `layout-pane:<tab>.<pane>` | Start a specific layout pane |
| `existing-tab:<name>` | Open all panes of a running tab |
| `existing-pane:<id>` | Attach to a specific running pane by moox ID |

## Interactive Picker

Two-panel TUI with Layouts (left) and Running (right).

### Keybindings

| Key | Action |
|---|---|
| j/k, Up/Down | Navigate items |
| h/l, Left/Right, Tab | Switch panel |
| g, 0 | Jump to top |
| G, $ | Jump to bottom |
| Enter | Select item |
| Shift+K | Kill selected pane or tab (with y/n confirmation) |
| Ctrl+L | Refresh session list |
| q, Escape, Ctrl+C, Ctrl+D | Quit |

### Panels

- **Layouts panel** (left): Shows "New Shell..." at top, layout tabs with their panes, and "Raw Shell" at bottom. Title shows "Layouts" for `z new`, or the current tab name for `z new pane`.
- **Running panel** (right): Shows running tabs grouped by `tab` moox var, with their panes. Each pane shows: icon, display name, moox session ID (grey, in brackets), and time ago / client status as dimmed suffix.

### Pane icons

- `\uf489` (terminal icon) — pane with 1+ attached clients
- `\uf444` (small dot) — disconnected pane (0 clients)

### Pane suffix

- Time ago (e.g. `3m ago`, `2h ago`, `Mar 15`)
- `[disconnected]` if 0 clients
- `[N attached]` if more than 1 client

### Selection bar

Full-width colored bar (configurable via `colors.selection`). No arrow indicator.

### Overlays

- **Directory chooser**: File-browser-style popup for selecting a working directory. Shows current path as editable input, subdirectories with fuzzy filtering. Enter=select, Space/Right/Tab=navigate into, Left=go up, Ctrl+U/Ctrl+W=delete to previous slash, Esc=cancel.
- **Kill confirmation**: `Kill <id>? (y/n)` popup. For tabs, shows `Kill tab "<name>" (N panes)? (y/n)` and kills all panes.

## Config Directory

`$XDG_CONFIG_HOME/z/` (or `~/.config/z/`). Auto-created on first run.

| File | Description |
|---|---|
| `config.yaml` | Default pane settings and colors |
| `layouts.yaml` | Layout tab definitions |
| `layouts.d/*.yaml` | Additional layout files (loaded alphabetically) |

## config.yaml

```yaml
# Default pane settings for "New Shell" menu items
#   name: kitty window title and moox pane var (omit to not set)
#   cmd:  command to run (omit for login shell)
#   dir:  "ask" to prompt, or a fixed path (omit for cwd)
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

### default section

| Field | Type | Description |
|---|---|---|
| `name` | string | Moox `pane` var and kitty window title. Omit to not set window title. |
| `cmd` | string | Command to run. Omit for login shell ($SHELL). |
| `dir` | string | `"ask"` to show directory chooser, a fixed path, or omit for cwd. |

### colors section

Each entry is a simple string (foreground only) or a dict:

```yaml
# Simple
tab: yellow

# Full
selection:
  fg: white
  bg: blue
  bold: true
  italic: false
  dim: false
  strikethrough: false
```

**Color values**: Named (`black`, `red`, `green`, `yellow`, `blue`, `magenta`/`purple`, `cyan`, `white`, `bright black`...`bright white`), hex (`"#ff5f00"`), short hex (`"#f50"` expands to `"#ff5500"`). Named colors respect terminal theme. Internally mapped to Ink/chalk names (e.g. `bright cyan` -> `cyanBright`).

| Key | Default | Applied to |
|---|---|---|
| `tab` | `yellow` | Tab items |
| `pane` | `green` | Pane items |
| `new` | `cyan` | "New Shell" / "Raw Shell" items |
| `running` | `dim` | Running panel headers |
| `selection` | `bg: blue, fg: white, bold` | Selection bar |

## layouts.yaml

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

  - name: 4_Shells
    dir: ask
    panes:
      - display: shell
      - name: Shell
      - name: Shell
      - name: Shell
```

### Tab fields

| Field | Type | Description |
|---|---|---|
| `name` | string | **Required.** Tab identifier. No spaces (use `_`, displayed as spaces). |
| `dir` | string | `"ask"`, a fixed path, or omit for cwd. Inherited by panes. |
| `panes` | list | List of pane definitions. |

### Pane fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Moox `pane` var and kitty window title (if set). No spaces. |
| `display` | string | Display name in picker TUI. Falls back to `name`, then `cmd`, then `"Shell"`. |
| `cmd` | string | Command to run. Omit for login shell. Passed as `$SHELL -c <cmd>`. |
| `dir` | string | Per-pane directory override. |

### Display name resolution (TUI)

`display` > `name` > `cmd` > `"Shell"`

### Moox pane var resolution

`name` > `"Shell"`

### Naming rules

- Tab names: no spaces (use `_`). Displayed with `_` as spaces. Must be unique.
- Pane names: no spaces (use `_`). Displayed with `_` as spaces.
- Validation runs on every layout load; errors shown with press-any-key-to-reload prompt.

## Kitty Integration

### Tab title

Set via `kitty @ set-tab-title` when:
- Creating a new tab from "New Shell..." (set to basename of chosen directory)
- Opening a layout tab (set to basename of resolved directory)
- Opening a layout pane as a new tab (set to basename of resolved directory)

### Window title

Set via `kitty @ set-window-title` when a pane has an explicit `name` in the layout config.

### Tab context detection

`kitty @ ls --self` returns JSON. If `.[0].tabs[0].title_overridden` is true, the tab title (`.[0].tabs[0].title`) is used as the tab context. This determines whether `z new` shows the tab picker or pane picker.

### Multi-pane launch

When opening a layout tab with multiple panes:
1. Panes 2+ are launched in new kitty windows via `kitty @ launch`
2. Pane 1 runs in the current window
3. Each kitty window runs `moox attach` directly (not through z)

```
kitty @ launch --env SHLVL=0 --cwd $DIR $SHELL -lc "kitty @ set-window-title <name>; moox attach --var tab=<tab> --var pane=<pane> - $SHELL -c <cmd>"
```

### Existing tab reattach

When opening an existing tab, all disconnected panes are opened in new kitty windows via `kitty @ launch` with `moox attach <id>`.

## Moox Integration

### Session creation

New sessions are created unnamed (using `-` as the name placeholder):

```
moox attach --var tab=<tabname> --var pane=<panename> - $SHELL
moox attach --var tab=<tabname> --var pane=<panename> - $SHELL -c <command>
```

`-v`/`--var` flags go before the name. `-` means unnamed. Everything after the name is the command.

### Session listing

```
moox list -j
```

Returns JSON array. z filters to sessions that have a `tab` var (z-managed sessions). Fields used: `id`, `tab`, `pane`, `created`, `clients`.

### Session vars

```
moox vars <id> --var key=val
```

### Session kill

```
moox kill <id>
```

After killing, z polls `moox list` every 100ms for up to 5 seconds until the killed sessions disappear, refreshing the UI each time.

### Existing session attach

```
moox attach <id>
```

No command passed — just reattaches to the existing session.

## Directory Resolution

When a layout tab/pane has `dir: ask`, or `config.default.dir: ask`:
1. The directory chooser overlay is shown
2. User navigates and selects a directory
3. The chosen directory becomes:
   - The moox session's cwd
   - The source of the kitty tab title (basename)

When `dir` is a fixed path:
- `~` is expanded to `$HOME`
- If the path doesn't exist, the directory chooser is shown pre-filled with that path

When `dir` is omitted:
- Current working directory is used

## Dependencies

| Package | Purpose |
|---|---|
| [moox](https://github.com/dannydulai/moox) | Session persistence backend |
| [Bun](https://bun.sh) | TypeScript runtime |
| [kitty](https://sw.kovidgoyal.net/kitty/) | Terminal emulator with remote control |
| [ink](https://github.com/vadimdemedes/ink) ^7.0.0 | React-based terminal UI framework |
| [react](https://react.dev) ^19.2.5 | UI component model |
| [yaml](https://www.npmjs.com/package/yaml) ^2.7.1 | YAML parsing |
