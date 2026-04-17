# z — Architecture

## Overview

z is a terminal workspace manager that orchestrates moox (persistent sessions) and kitty (terminal emulator) to provide tmux-like tab/pane management without taking over window management. Written in TypeScript, runs on Bun, uses Ink (React) for the TUI.

## File Structure

```
z/
  src/
    index.ts          CLI entry point, command routing, picker orchestration
    config.ts         Config + layout YAML parsing, validation, color normalization
    moox.ts           moox CLI interactions, kitty window launching, session helpers
    ui/
      App.tsx          Main React component (panels, overlays, keyboard handling)
      Panel.tsx        Scrollable list panel with selection and item rendering
      BottomBar.tsx    Static footer with keybinding hints
      DirInput.tsx     Directory chooser overlay (fuzzy file browser)
      render.tsx       Ink render wrapper, stdin cleanup, type exports
  package.json
  tsconfig.json
  SPEC.md             Full specification
  ARCHITECTURE.md     This file
```

## Data Flow

```
User input
    |
    v
index.ts (CLI parsing)
    |
    +-- z new / z new pane --> picker flow
    |       |
    |       v
    |   render.tsx (Ink mount/unmount, alt screen, stdin cleanup)
    |       |
    |       v
    |   App.tsx (keyboard dispatch, overlay state, panel refs)
    |       |
    |       +-- Panel.tsx (imperative handle: moveUp/Down/Top/Bottom, select)
    |       +-- DirInput.tsx (directory browser overlay)
    |       +-- BottomBar.tsx (static help)
    |       |
    |       v
    |   PickerResult { choice, dir?, name? }
    |       |
    |       v
    |   index.ts (execNewWhat / execNewPaneWhat / direct handlers)
    |       |
    |       v
    |   moox.ts (mooxAttach / kittyLaunchMoox / kittyAttachMoox / mooxKill)
    |       |
    |       v
    |   moox CLI + kitty remote control
    |
    +-- z ls --> handleLs (stdout, no TUI)
```

## Key Design Decisions

### No session names

moox sessions are created unnamed (`-` as the name placeholder). Identity comes from moox session variables (`tab=`, `pane=`). The moox-generated hex ID is used for reattaching and display. This avoids naming collisions and simplifies the model.

### Tab grouping by moox var

Running sessions are grouped into tabs by their `tab` moox variable, not by any ID scheme. Two sessions with `tab=myproject` are in the same tab regardless of when they were created.

### Kitty tab title as tab context

When `z new` or `z new pane` runs, it checks `kitty @ ls --self` for an overridden tab title. If found, z knows it's in an existing tab context and shows the pane picker. If not, z shows the full tab picker. This avoids requiring explicit tab references on the command line.

### Tab name from directory basename

When creating a new tab (via "New Shell" or a layout), the kitty tab title is set to `basename(dir)`, not the layout tab name. This makes tab names reflect what you're actually working on.

### Ink for TUI, not a custom renderer

Earlier versions used a hand-rolled picker (picker.ts). The current version uses Ink + React for the TUI. This provides:
- Proper component model for overlays
- Flexbox layout
- Built-in color/style support via chalk
- Alternating screen management

The tradeoff is Ink's `useInput` fires for ALL components (no event stopping), so there's exactly ONE `useInput` in App.tsx that dispatches to Panel via imperative refs.

### Kitty keyboard protocol

Kitty sends press AND release events. Ink's `useInput` fires for both. All `useInput` handlers filter `(key as any).eventType === "release"`.

### Commands passed via $SHELL -c

When a pane has a `cmd`, it's run as `$SHELL -c <cmd>`. When no cmd, just `$SHELL` (login shell). The `-` separator tells moox where the name ends and command begins. `-v` flags go before the name.

### Directory chooser

The DirInput component is a file-browser-style directory picker:
- State: `path` string (editable) + `selIdx` (highlighted entry)
- When path ends with `/`: shows all subdirs
- When path has trailing partial: shows subdirs filtered by fuzzy match
- Enter with highlight: picks entry (replaces partial, appends `/`)
- Enter without highlight: submits path
- Ctrl+U/W: delete back to previous `/`

### Kill with polling

After `moox kill`, the UI polls `moox list -j` every 100ms for up to 5 seconds, refreshing the panel each time. This ensures the killed session disappears from the UI even if moox takes a moment to clean up.

### Overlay state management

The App has three overlay states: `dirPrompt`, `namePrompt`, `killConfirm`. When any is active:
- Main `useInput` is blocked (`if (dirPrompt || namePrompt) return`)
- Panel `focused` props are set to false
- Overlay components handle their own input via separate `useInput`

A `popupJustClosed` ref prevents Escape from closing an overlay AND quitting the picker in the same keypress.

## Color System

Colors in config are stored as `Style` objects (`{ fg?, bg?, bold?, italic?, dim?, strikethrough? }`). Color names are mapped from user-facing format (`bright cyan`) to Ink/chalk format (`cyanBright`) at config load time. Hex values are passed through (short hex `#abc` expanded to `#aabbcc`).

## Things to Know

- `bun run src/index.ts` in the `z/` dir runs the app. Or `bun src/index.ts` directly.
- The parent repo has its own `package.json` with a `dev` script that runs a different TUI app. Don't use `bun run dev` from the z/ directory if the parent catches it.
- `moox list -j` returns JSON. The old tab-delimited format is no longer used.
- `moox attach` requires `-v` flags before the name/id. The `-` placeholder means "unnamed session".
- `moox attach -` with no command uses the login shell.
- `moox attach <id>` with no command reattaches without overwriting the session's command.
- `kitty @ launch` spawns a new window. `kitty @ ls --self` returns the current window/tab info. `kitty @ set-tab-title` and `kitty @ set-window-title` set titles.
- After Ink unmounts, `render.tsx` explicitly resets stdin (setRawMode false, removeAllListeners, pause) to prevent Ink from stealing keystrokes from subsequent moox attach.
- The `paneName()` function returns `name || "Shell"`. It does NOT fall back to `cmd` (cmd can contain flags that break moox arg parsing).
- The `paneDisplay()` function returns `display || name || cmd || "Shell"` — used only for TUI labels.
- Underscore `_` in tab/pane names is displayed as space in the TUI via the `dn()` helper.
- Layout validation rejects names containing spaces (must use `_` instead).
- `process.exit()` is called after `mooxAttach` returns — z does not loop back to the picker after attaching.
