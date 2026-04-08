// view.ts — View rendering: layout, borders, list formatting, scrolling.

import stringWidth from "string-width";
import {
  type Session,
  displayDir,
  formatBytes,
  formatUptime,
  ansiSlice,
  truncateStr,
  padLeft,
  fillRight,
} from "../zmx.ts";
import {
  type Model,
  State,
  sortLabel,
  visibleSessions,
  visibleMetrics,
  killTarget,
  mainContentHeight,
  listOuterWidth,
  listInnerWidth,
  previewOuterWidth,
  previewInnerWidth,
} from "./model.ts";
import {
  selectedStyle,
  normalStyle,
  activeClientStyle,
  inactiveClientStyle,
  titleStyle,
  helpStyle,
  helpKeyStyle,
  statusStyle,
  confirmStyle,
  logDimStyle,
  pidStyle,
  memStyle,
  uptimeStyle,
  filterMatchStyle,
  sortStyle,
  borderCharStyle,
} from "./styles.ts";

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function view(m: Model): string {
  if (m.error) {
    return `\n  Error: ${m.error.message}\n\n  Is zmx installed and in your PATH?\n`;
  }
  if (m.width === 0) return "  Loading...";

  const visible = visibleSessions(m);

  // Compute help first so we know its height for layout
  const help = renderHelp(m);
  const helpLines = help.split("\n").length;
  const ch = mainContentHeight(m, helpLines);

  // --- List pane ---
  const listContent = clampLines(renderList(m, ch), ch);

  let listTitleLeft: string;
  if (visible.length !== m.sessions.length) {
    listTitleLeft = ` zmx (${visible.length}/${m.sessions.length}) `;
  } else {
    listTitleLeft = ` zmx sessions (${visible.length}) `;
  }
  const sortArrow = m.sortAsc ? "↑" : "↓";
  const listTitleRight = ` ${sortArrow} ${sortLabel(m.sortMode)} `;

  const low = listOuterWidth(m);
  let listPane = renderBox(listContent, low, ch + 2);
  listPane = replaceTopBorder(
    listPane,
    buildTopBorderLRStyled(listTitleLeft, listTitleRight, low, sortStyle),
  );

  // --- Preview pane ---
  const pw = previewInnerWidth(m);
  const previewContent = renderPreviewContent(m.preview, m.previewScrollX, m.previewScrollY, pw, ch);
  let previewTitleLeft = " Preview ";
  let previewTitleRight = "";
  if (m.cursor < visible.length) {
    const s = visible[m.cursor];
    previewTitleLeft = ` ${s.name} `;
    previewTitleRight = ` 📂 ${displayDir(s.startedIn)} `;
  }
  const pow = previewOuterWidth(m);
  let previewPane = renderBox(previewContent, pow, ch + 2);
  previewPane = replaceTopBorder(
    previewPane,
    buildTopBorderLR(previewTitleLeft, previewTitleRight, pow),
  );

  // Join list + preview horizontally
  const bodyLines = joinHorizontal(listPane, previewPane);

  const full = bodyLines + "\n" + help;
  return clampLines(full, m.height);
}

// ---------------------------------------------------------------------------
// List rendering
// ---------------------------------------------------------------------------

function renderList(m: Model, maxRows: number): string {
  const lw = listInnerWidth(m);
  const visible = visibleSessions(m);
  if (visible.length === 0) {
    if (m.filterText !== "") {
      return centerMessage(["", "", "no", "matches", "", "esc to", "clear"], lw);
    }
    return centerMessage(["", "", "no", "sessions", "", "r to", "refresh"], lw);
  }
  const metrics = visibleMetrics(m);
  const lines: string[] = [];

  const end = Math.min(m.listOffset + maxRows, visible.length);
  for (let i = m.listOffset; i < end; i++) {
    const s = visible[i];
    const isCursor = i === m.cursor;

    // Indicator column (2 chars)
    const indicator = isCursor ? selectedStyle("▸ ") : "  ";

    // Client indicator
    let clientInd: string;
    if (s.clients > 0) {
      clientInd = activeClientStyle(padLeft(`●${s.clients}`, metrics.clientW));
    } else {
      clientInd = inactiveClientStyle(padLeft("○0", metrics.clientW));
    }

    const pidStr = pidStyle(padLeft(s.pid, metrics.pidW));

    const memLabel = s.memory > 0 ? formatBytes(s.memory) : "-";
    const memStr = memStyle(padLeft(memLabel, metrics.memW));

    const uptimeLabel = s.uptime > 0 ? formatUptime(s.uptime) : "-";
    const uptimeStr = uptimeStyle(padLeft(uptimeLabel, metrics.uptimeW));

    // Name column: remaining space
    let nameWidth =
      lw - 6 - metrics.pidW - metrics.memW - metrics.uptimeW - metrics.clientW;
    if (nameWidth < 10) nameWidth = 10;
    const name = truncateStr(s.name, nameWidth);
    const paddedName = fillRight(name, nameWidth);

    const style = isCursor ? selectedStyle : normalStyle;

    let styledName: string;
    if (m.filterText !== "") {
      styledName = highlightMatch(paddedName, m.filterText, style, filterMatchStyle);
    } else {
      styledName = style(paddedName);
    }

    lines.push(
      `${indicator}${styledName} ${pidStr} ${memStr} ${uptimeStr} ${clientInd}`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Log rendering
// ---------------------------------------------------------------------------
// Preview content with vertical + horizontal scrolling
// ---------------------------------------------------------------------------

function renderPreviewContent(
  raw: string,
  offsetX: number,
  offsetY: number,
  maxWidth: number,
  maxHeight: number,
): string {
  const allLines = raw.split("\n");
  const total = allLines.length;

  // offsetY=0 means bottom (newest), positive = scrolled up
  const endLine = Math.max(0, total - offsetY);
  const startLine = Math.max(0, endLine - maxHeight);
  const visible = allLines.slice(startLine, endLine);

  return visible
    .map((line) => {
      // ANSI-aware horizontal slice — preserves color/style codes
      const sliced = ansiSlice(line, offsetX, maxWidth);
      return fillRight(sliced, maxWidth);
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Help bar
// ---------------------------------------------------------------------------

function renderHelp(m: Model): string {
  if (m.state === State.Killing) {
    return helpKeyStyle(" q") + helpStyle(" quit");
  }

  if (m.state === State.Filter) {
    const cursor = "█";
    return (
      helpStyle(" /") +
      helpKeyStyle(m.filterText) +
      helpStyle(cursor + "  Enter accept | Esc clear")
    );
  }

  if (m.state === State.ConfirmKill) {
    const target = killTarget(m);
    return confirmStyle(` Kill ${target}? y/n `);
  }

  const parts: string[] = [
    helpKeyStyle("hjkl") + helpStyle(" preview"),
    helpKeyStyle("↑↓") + helpStyle(" nav"),
    helpKeyStyle("enter") + helpStyle(" attach"),
    helpKeyStyle("x") + helpStyle(" kill"),
    helpKeyStyle("c") + helpStyle(" copy"),
    helpKeyStyle("s") + helpStyle(" sort"),
  ];
  if (m.filterText !== "") {
    parts.push(helpKeyStyle("esc") + helpStyle(" clear"));
  } else {
    parts.push(helpKeyStyle("/") + helpStyle(" filter"));
  }
  parts.push(helpKeyStyle("q") + helpStyle(" quit"));

  if (m.status !== "") {
    parts.push(statusStyle(m.status));
  }

  return wrapHelpParts(parts, m.width);
}

function wrapHelpParts(parts: string[], maxWidth: number): string {
  if (maxWidth <= 0) return " " + parts.join("  ");
  const lines: string[] = [];
  let line = " ";
  let lineW = 1;
  for (let i = 0; i < parts.length; i++) {
    const pw = stringWidth(parts[i]);
    const sep = i === 0 ? "" : "  ";
    const sepW = i === 0 ? 0 : 2;
    if (lineW + sepW + pw > maxWidth && lineW > 1) {
      lines.push(line);
      line = " " + parts[i];
      lineW = 1 + pw;
    } else {
      line += sep + parts[i];
      lineW += sepW + pw;
    }
  }
  lines.push(line);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Box rendering (replaces lipgloss border rendering)
// ---------------------------------------------------------------------------

function renderBox(content: string, outerWidth: number, outerHeight: number): string {
  const innerW = outerWidth - 2;
  const innerH = outerHeight - 2;

  const top = borderCharStyle("╭" + "─".repeat(Math.max(0, innerW)) + "╮");
  const bottom = borderCharStyle("╰" + "─".repeat(Math.max(0, innerW)) + "╯");

  const contentLines = content.split("\n");
  const middle: string[] = [];
  for (let i = 0; i < innerH; i++) {
    const raw = i < contentLines.length ? contentLines[i] : "";
    const padded = padLine(raw, innerW);
    middle.push(borderCharStyle("│") + padded + borderCharStyle("│"));
  }

  return [top, ...middle, bottom].join("\n");
}

/** Pad (or leave) a line to exactly `width` display columns. */
function padLine(line: string, width: number): string {
  const w = stringWidth(line);
  if (w >= width) return line;
  return line + " ".repeat(width - w);
}

// ---------------------------------------------------------------------------
// Border helpers
// ---------------------------------------------------------------------------

function buildTopBorder(title: string, outerWidth: number): string {
  return buildTopBorderLR(title, "", outerWidth);
}

function buildTopBorderLR(
  left: string,
  right: string,
  outerWidth: number,
): string {
  return buildTopBorderLRStyled(left, right, outerWidth, logDimStyle);
}

function buildTopBorderLRStyled(
  left: string,
  right: string,
  outerWidth: number,
  rightStyleFn: (s: string) => string,
): string {
  let styledLeft = titleStyle(left);
  let leftVW = stringWidth(styledLeft);

  let styledRight = "";
  let rightVW = 0;
  if (right) {
    styledRight = rightStyleFn(right);
    rightVW = stringWidth(styledRight);
  }

  const maxVW = Math.max(1, outerWidth - 4);

  // Truncate right first to preserve left (session name)
  if (leftVW + rightVW > maxVW) {
    const maxRight = maxVW - leftVW - 1;
    if (maxRight < 4) {
      styledRight = "";
      rightVW = 0;
    } else {
      right = truncateStr(right, maxRight);
      styledRight = rightStyleFn(right);
      rightVW = stringWidth(styledRight);
    }
  }
  // If still too wide, truncate left
  if (leftVW + rightVW > maxVW) {
    left = truncateStr(left, maxVW - rightVW - 1);
    styledLeft = titleStyle(left);
    leftVW = stringWidth(styledLeft);
  }

  const fill = Math.max(0, outerWidth - 3 - leftVW - rightVW);

  if (styledRight) {
    return (
      borderCharStyle("╭─") +
      styledLeft +
      borderCharStyle("─".repeat(fill)) +
      styledRight +
      borderCharStyle("╮")
    );
  }
  return (
    borderCharStyle("╭─") +
    styledLeft +
    borderCharStyle("─".repeat(fill) + "╮")
  );
}

function buildBottomBorderR(right: string, outerWidth: number): string {
  const styledRight = selectedStyle(right);
  const rightVW = stringWidth(styledRight);
  const fill = Math.max(0, outerWidth - 2 - rightVW);
  return (
    borderCharStyle("╰" + "─".repeat(fill)) +
    styledRight +
    borderCharStyle("╯")
  );
}

function replaceTopBorder(pane: string, newTop: string): string {
  const idx = pane.indexOf("\n");
  if (idx < 0) return pane;
  return newTop + pane.slice(idx);
}

function replaceBottomBorder(pane: string, newBottom: string): string {
  const idx = pane.lastIndexOf("\n");
  if (idx < 0) return pane;
  return pane.slice(0, idx + 1) + newBottom;
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

function centerMessage(words: string[], width: number): string {
  return words
    .map((w) => {
      if (!w) return "";
      const pad = Math.max(0, Math.floor((width - stringWidth(w)) / 2));
      return " ".repeat(pad) + logDimStyle(w);
    })
    .join("\n");
}

function clampLines(s: string, maxLines: number): string {
  if (maxLines <= 0) return "";
  const lines = s.split("\n");
  if (lines.length <= maxLines) return s;
  return lines.slice(0, maxLines).join("\n");
}

/** Highlight the first case-insensitive match of query in s. */
function highlightMatch(
  s: string,
  query: string,
  baseFn: (s: string) => string,
  hlFn: (s: string) => string,
): string {
  const lower = s.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) return baseFn(s);
  const end = idx + query.length;
  return baseFn(s.slice(0, idx)) + hlFn(s.slice(idx, end)) + baseFn(s.slice(end));
}

// ---------------------------------------------------------------------------
// Horizontal join (side-by-side panes)
// ---------------------------------------------------------------------------

function joinHorizontal(left: string, right: string): string {
  const lLines = left.split("\n");
  const rLines = right.split("\n");
  const maxLen = Math.max(lLines.length, rLines.length);
  const result: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const l = i < lLines.length ? lLines[i] : "";
    const r = i < rLines.length ? rLines[i] : "";
    result.push(l + r);
  }
  return result.join("\n");
}
