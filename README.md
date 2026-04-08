# zsessions

A TUI session manager for [zmx](https://github.com/nicholasgasior/zmx), built with Bun and TypeScript.

Browse, preview, attach to, and kill zmx sessions from an interactive terminal interface with color-preserved history preview and vi-style navigation.

## Requirements

- [Bun](https://bun.sh) (v1.0+)
- [zmx](https://github.com/nicholasgasior/zmx) in your PATH

## Install

```bash
git clone https://github.com/dannydulai/zsessions.git
cd zsessions
bun install
```

## Usage

```bash
bun run src/index.ts
```

Or compile to a standalone binary:

```bash
bun run build
./zsm-bun
```

## Key Bindings

| Key | Action |
|-----|--------|
| `↑` `↓` | Navigate sessions |
| `h` `j` `k` `l` | Scroll preview (vi-style) |
| `H` `J` `K` `L` | Scroll preview fast (10x) |
| `PgUp` `PgDn` | Page through preview |
| `enter` | Attach to session |
| `x` | Kill session |
| `c` | Copy attach command to clipboard (OSC 52) |
| `s` | Cycle sort (name/clients/pid/memory/uptime) |
| `S` | Cycle sort in reverse |
| `/` | Filter sessions |
| `r` | Refresh session list |
| `q` | Quit |

## Architecture

- **`src/tea.ts`** -- Lightweight Bubble Tea-like terminal UI runtime (alt screen, raw mode, key parsing, Elm-architecture event loop)
- **`src/zmx.ts`** -- All zmx CLI interactions (session listing, kill, process tree, preview with ANSI color preservation)
- **`src/tui/model.ts`** -- Application state, caching, layout, async commands
- **`src/tui/update.ts`** -- Message handling and keyboard input
- **`src/tui/view.ts`** -- Rendering (bordered panes, ANSI-aware horizontal slicing, styled list)
- **`src/tui/styles.ts`** -- Terminal color/style definitions via chalk

## License

MIT
