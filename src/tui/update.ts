// update.ts — Message handling (Update) and keyboard input handlers.

import type { Cmd, KeyPressMsg, Msg } from "../tea.ts";
import {
  KeyUp,
  KeyDown,
  KeyLeft,
  KeyRight,
  KeyEnter,
  KeySpace,
  KeyEscape,
  KeyBackspace,
  KeyPgUp,
  KeyPgDn,
  quitCmd,
  batch,
} from "../tea.ts";
import { copyToClipboard, previewMaxWidth } from "../zmx.ts";
import {
  type Model,
  State,
  SortMode,
  SORT_MODE_COUNT,
  visibleSessions,
  markSessionsChanged,
  markVisibleChanged,
  clampCursor,
  ensureVisible,
  killTarget,
  previewCmd,
  previewInnerWidth,
  mainContentHeight,
  fetchSessionsCmd,
  fetchProcessInfoCmd,
  killOneCmd,
  waitForGoneCmd,
  clearStatusAfter,
} from "./model.ts";
import { statusStyle } from "./styles.ts";

// ---------------------------------------------------------------------------
// Main update dispatcher
// ---------------------------------------------------------------------------

export function update(m: Model, msg: Msg): Cmd[] {
  switch (msg.type) {
    case "windowSize":
      m.width = msg.width;
      m.height = msg.height;
      if (m.state !== State.Killing) {
        const vis = visibleSessions(m);
        if (m.cursor < vis.length) return batch(previewCmd(m));
      }
      return [];

    case "sessions": {
      if (msg.error) {
        m.error = msg.error as Error;
        return [];
      }
      m.sessions = msg.sessions as Session[];
      markSessionsChanged(m);

      clampCursor(m);

      const cmds: Cmd[] = [fetchProcessInfoCmd(m.sessions)];
      const vis = visibleSessions(m);
      if (vis.length > 0 && m.cursor < vis.length) {
        cmds.push(previewCmd(m));
      } else {
        m.preview = "";
      }
      return cmds;
    }

    case "processInfo": {
      const info = msg.info as Map<string, { memory: number; uptime: number }>;
      let updated = false;
      for (const s of m.sessions) {
        const pi = info.get(s.name);
        if (pi) {
          s.memory = pi.memory;
          s.uptime = pi.uptime;
          updated = true;
        }
      }
      if (updated) markSessionsChanged(m);
      return [];
    }

    case "preview": {
      const vis = visibleSessions(m);
      if (m.cursor < vis.length && vis[m.cursor].name === msg.name) {
        m.preview = msg.content as string;
      }
      return [];
    }

    case "killOneResult": {
      if (msg.error) {
        } else {

        m.killDoneNames.push(msg.name as string);
      }
      m.killNow = "";
      if (m.killQueue.length > 0) {
        const next = m.killQueue.shift()!;
        m.killNow = next;

        return [killOneCmd(next)];
      }
      if (m.killDoneNames.length > 0) {

        return [waitForGoneCmd(m.killDoneNames, 0)];
      }
      return finishKill(m);
    }

    case "waitCheck":
      return [waitForGoneCmd(msg.names, msg.attempt)];

    case "allGone":
      return finishKill(m);

    case "statusClear":
      m.status = "";
      return [];

    case "keypress":
      return handleKeyPress(m, msg as KeyPressMsg);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Kill completion
// ---------------------------------------------------------------------------

function finishKill(m: Model): Cmd[] {
  const killed = m.killDoneNames.length;

  m.state = State.Normal;
  m.filterText = "";
  markVisibleChanged(m);
  m.cursor = 0;
  m.listOffset = 0;
  m.killQueue = [];
  m.killDoneNames = [];
  m.killNow = "";
  return [fetchSessionsCmd(), clearStatusAfter(3000)];
}

// ---------------------------------------------------------------------------
// Key dispatch
// ---------------------------------------------------------------------------

function handleKeyPress(m: Model, msg: KeyPressMsg): Cmd[] {
  if (m.state === State.Killing) {
    if (isQuit(msg)) return [quitCmd];

    return [];
  }
  if (m.state === State.Filter) return handleFilterKey(m, msg);
  return handleKey(m, msg);
}

// ---------------------------------------------------------------------------
// Normal-mode keys
// ---------------------------------------------------------------------------

function handleKey(m: Model, msg: KeyPressMsg): Cmd[] {
  if (m.state === State.ConfirmKill) return handleConfirmKey(m, msg);

  if (isQuit(msg)) return [quitCmd];

  // Escape or Backspace clears active filter in normal mode
  if (
    (msg.code === KeyEscape || msg.code === KeyBackspace) &&
    m.filterText !== ""
  ) {
    m.filterText = "";
    markVisibleChanged(m);
    m.cursor = 0;
    m.listOffset = 0;
    return batch(previewCmd(m));
  }

  const visible = visibleSessions(m);

  switch (msg.code) {
    case KeyUp:
      if (m.cursor > 0) {
        m.cursor--;
        m.previewScrollX = 0;
        m.previewScrollY = 0;
        ensureVisible(m);
        return batch(previewCmd(m));
      }
      break;

    case KeyDown:
      if (m.cursor < visible.length - 1) {
        m.cursor++;
        m.previewScrollX = 0;
        m.previewScrollY = 0;
        ensureVisible(m);
        return batch(previewCmd(m));
      }
      break;

    case KeyLeft:
      scrollPreviewLeft(m, 2);
      break;

    case KeyRight:
      scrollPreviewRight(m, 2);
      break;

    case KeyPgUp:
      scrollPreviewUp(m, mainContentHeight(m, 1) - 1);
      break;

    case KeyPgDn:
      scrollPreviewDown(m, mainContentHeight(m, 1) - 1);
      break;

    case KeyEnter:
      if (m.cursor < visible.length) {
        m.attachTarget = visible[m.cursor].name;
        return [quitCmd];
      }
      break;

    default:
      if (msg.text) {
        switch (msg.text) {
          // hjkl — vi-style preview scrolling, HJKL = 10x
          case "h":
          case "H":
            scrollPreviewLeft(m, msg.text === "H" ? 20 : 2);
            break;
          case "l":
          case "L":
            scrollPreviewRight(m, msg.text === "L" ? 20 : 2);
            break;
          case "k":
          case "K":
            scrollPreviewUp(m, msg.text === "K" ? 10 : 1);
            break;
          case "j":
          case "J":
            scrollPreviewDown(m, msg.text === "J" ? 10 : 1);
            break;
          case "x": {
            const target = killTarget(m);
            if (target) m.state = State.ConfirmKill;
            break;
          }
          case "c":
            if (m.cursor < visible.length) {
              const name = visible[m.cursor].name;
              const text = `zmx attach ${name}`;
              copyToClipboard(text);
              m.status = "Copied!";

              return [clearStatusAfter(2000)];
            }
            break;
          case "r":
            return [fetchSessionsCmd()];
          case "/":
            m.state = State.Filter;
            break;
          case "s":
            if (m.sortAsc) {
              m.sortAsc = false;
            } else {
              m.sortAsc = true;
              m.sortMode = ((m.sortMode + 1) % SORT_MODE_COUNT) as SortMode;
            }
            markVisibleChanged(m);
            m.cursor = 0;
            m.listOffset = 0;
            return batch(previewCmd(m));
          case "S":
            if (!m.sortAsc) {
              m.sortAsc = true;
            } else {
              m.sortAsc = false;
              m.sortMode = ((m.sortMode - 1 + SORT_MODE_COUNT) % SORT_MODE_COUNT) as SortMode;
            }
            markVisibleChanged(m);
            m.cursor = 0;
            m.listOffset = 0;
            return batch(previewCmd(m));
        }
      }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Filter-mode keys
// ---------------------------------------------------------------------------

function handleFilterKey(m: Model, msg: KeyPressMsg): Cmd[] {
  if (isQuit(msg)) return [quitCmd];

  switch (msg.code) {
    case KeyEscape:
      m.filterText = "";
      markVisibleChanged(m);
      m.state = State.Normal;
      m.cursor = 0;
      m.listOffset = 0;
      return batch(previewCmd(m));

    case KeyEnter:
      m.state = State.Normal;
      clampCursor(m);
      return batch(previewCmd(m));

    case KeyBackspace:
      if (m.filterText.length > 0) {
        m.filterText = m.filterText.slice(0, -1);
        markVisibleChanged(m);

        m.cursor = 0;
        m.listOffset = 0;
      } else {
        m.state = State.Normal;
        return batch(previewCmd(m));
      }
      break;

    case KeyUp:
      if (m.cursor > 0) {
        m.cursor--;
        ensureVisible(m);
        return batch(previewCmd(m));
      }
      break;

    case KeyDown: {
      const visible = visibleSessions(m);
      if (m.cursor < visible.length - 1) {
        m.cursor++;
        ensureVisible(m);
        return batch(previewCmd(m));
      }
      break;
    }

    default:
      if (msg.text) {
        m.filterText += msg.text;
        markVisibleChanged(m);

        m.cursor = 0;
        m.listOffset = 0;
      }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Confirm-kill keys
// ---------------------------------------------------------------------------

function handleConfirmKey(m: Model, msg: KeyPressMsg): Cmd[] {
  if (isQuit(msg)) return [quitCmd];

  if (msg.code === KeyEscape || msg.code === KeyBackspace) {
    m.state = State.Normal;
    return [];
  }

  if (msg.text === "y") {
    const target = killTarget(m);
    if (!target) { m.state = State.Normal; return []; }
    m.state = State.Killing;
    m.killDoneNames = [];
    m.killQueue = [];
    m.killNow = target;
    return [killOneCmd(target)];
  }

  if (msg.text === "n") {
    m.state = State.Normal;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isQuit(msg: KeyPressMsg): boolean {
  if (msg.code === "c" && msg.mod.ctrl) return true;
  return msg.text === "q";
}


function scrollPreviewLeft(m: Model, cols: number) {
  m.previewScrollX = Math.max(0, m.previewScrollX - cols);
}

function scrollPreviewRight(m: Model, cols: number) {
  const maxW = previewMaxWidth(m.preview);
  const pw = previewInnerWidth(m);
  const limit = Math.max(0, maxW - pw);
  m.previewScrollX = Math.min(limit, m.previewScrollX + cols);
}

function scrollPreviewUp(m: Model, lines: number) {
  const totalLines = m.preview.split("\n").length;
  const ch = mainContentHeight(m, 1);
  const maxScroll = Math.max(0, totalLines - ch);
  m.previewScrollY = Math.min(maxScroll, m.previewScrollY + lines);
}

function scrollPreviewDown(m: Model, lines: number) {
  m.previewScrollY = Math.max(0, m.previewScrollY - lines);
}
