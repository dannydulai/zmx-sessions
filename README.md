# z

`z` is a terminal workspace manager for people who live in the command line and want their sessions to stay organized, persistent, and fast to reopen.

Built on top of [moox](https://github.com/dannydulai/moox), `z` gives you a clean way to launch and reconnect to named terminal workspaces across [kitty](https://sw.kovidgoyal.net/kitty/) tabs and panes, with a fast interactive picker for jumping back into work.

## Why z exists

Plain terminal tabs are easy to open and easy to lose.

Terminal multiplexers are powerful, but they often ask you to commit to a whole different operating model.

`z` sits in the middle:

- keep using `kitty`
- keep your shells persistent with `moox`
- define repeatable layouts for common work
- reopen running sessions without hunting around
- launch multi-pane setups with a couple keystrokes

The result feels less like session management and more like having a workspace launcher for your terminal.

## What it does

`z` organizes terminal work around a few simple ideas:

- **Tabs** are logical workspaces
- **Panes** are persistent shells inside those workspaces
- **Layouts** are saved templates for common setups
- **Running sessions** can be reopened instantly from the picker

From the TUI, you can:

- start a fresh shell
- open a saved layout
- reopen a running tab or pane
- preview pane history inline
- kill panes or whole tabs
- launch all panes from a running tab at once

## Why it feels good

- **Fast recovery**: jump back into work without rebuilding your terminal state
- **Repeatable setups**: keep project layouts in config instead of in memory
- **Visual navigation**: browse layouts and running sessions side by side
- **Persistent context**: your shells stay alive even when you disconnect
- **Low ceremony**: you still work in normal terminal windows and tabs

## Who it’s for

`z` is a strong fit if you:

- work across several repos or services at once
- regularly rebuild the same multi-pane setup
- want persistence without moving your whole workflow into tmux
- like `kitty` and want it to behave more like a workspace system

## Requirements

`z` currently depends on:

- [kitty](https://sw.kovidgoyal.net/kitty/)
- [moox](https://github.com/dannydulai/moox)
- Rust, if you are building from source

## Quick start

Build it:

```bash
cargo build --release
```

Launch the main picker:

```bash
./target/release/z new
```

Open a pane inside the current tab context:

```bash
./target/release/z new pane
```

List running sessions:

```bash
./target/release/z ls tabs
./target/release/z ls panes
```

## Configuration

`z` reads config from:

```text
~/.config/z/
```

Main files:

- `config.yaml` for default shell behavior and colors
- `layouts.yaml` for workspace templates
- `layouts.d/*.yaml` for additional layout files

Layouts let you define tabs, pane names, commands, and working directories so your common environments are one selection away.

## Project status

This project is actively focused on the core experience:

- launching and reopening terminal workspaces quickly
- making persistent sessions easy to browse
- keeping the UI fast and lightweight

It is opinionated around `kitty` + `moox`, which is part of what keeps the workflow simple.

## Learn more

- Product and behavior spec: [SPEC.md](SPEC.md)
- Internal architecture notes: [ARCHITECTURE.md](ARCHITECTURE.md)
