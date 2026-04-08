// zmx.ts — All interactions with the zmx CLI, process tree analysis, and string utilities.

import stringWidth from "string-width";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Session {
  name: string;
  pid: string;
  clients: number;
  startedIn: string;
  cmd: string;
  memory: number; // RSS of process tree in bytes
  uptime: number; // elapsed seconds from ps etime
}

export interface ProcessInfo {
  memory: number;
  uptime: number;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

export function displayDir(startedIn: string): string {
  const home = homedir();
  if (home && startedIn.startsWith(home)) {
    return "~" + startedIn.slice(home.length);
  }
  return startedIn;
}

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------

export async function fetchSessions(): Promise<Session[]> {
  const proc = Bun.spawn(["zmx", "list"], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`zmx list: exit ${exitCode}\n${output}`);
  }

  const sessions: Session[] = [];
  for (const line of output.trim().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const s: Session = {
      name: "",
      pid: "",
      clients: 0,
      startedIn: "",
      cmd: "",
      memory: 0,
      uptime: 0,
    };
    for (const field of trimmed.split("\t")) {
      const eqIdx = field.indexOf("=");
      if (eqIdx < 0) continue;
      // Strip leading non-alpha chars (e.g. → arrow for active session)
      const k = field.slice(0, eqIdx).replace(/^[^a-zA-Z_]+/, "");
      const v = field.slice(eqIdx + 1);
      switch (k) {
        case "session_name":
        case "name":
          s.name = v;
          break;
        case "pid":
          s.pid = v;
          break;
        case "clients":
          s.clients = parseInt(v, 10) || 0;
          break;
        case "started_in":
        case "start_dir":
          s.startedIn = v;
          break;
        case "cmd":
          s.cmd = v;
          break;
      }
    }
    if (s.name) sessions.push(s);
  }
  return sessions;
}

export async function killSession(name: string): Promise<void> {
  const proc = Bun.spawn(["zmx", "kill", name], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`zmx kill ${name}: exit ${exitCode}\n${output}`);
  }
}

export function copyToClipboard(text: string): void {
  // OSC 52 escape sequence — works across terminals including over SSH/tmux
  const b64 = Buffer.from(text).toString("base64");
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
}

// ---------------------------------------------------------------------------
// Process tree
// ---------------------------------------------------------------------------

export async function fetchProcessInfo(
  sessions: Session[],
): Promise<Map<string, ProcessInfo>> {
  const { rssMap, childMap, etimeMap } = await readProcessTable();
  const result = new Map<string, ProcessInfo>();
  for (const s of sessions) {
    const pid = parseInt(s.pid, 10);
    if (isNaN(pid)) continue;
    result.set(s.name, {
      memory: sumTreeRSS(pid, rssMap, childMap),
      uptime: etimeMap.get(pid) ?? 0,
    });
  }
  return result;
}

async function readProcessTable(): Promise<{
  rssMap: Map<number, number>;
  childMap: Map<number, number[]>;
  etimeMap: Map<number, number>;
}> {
  const rssMap = new Map<number, number>();
  const childMap = new Map<number, number[]>();
  const etimeMap = new Map<number, number>();

  try {
    const proc = Bun.spawn(["ps", "-eo", "pid,ppid,rss,etime"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    for (const line of output.split("\n")) {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 4) continue;
      const pid = parseInt(fields[0], 10);
      const ppid = parseInt(fields[1], 10);
      const kib = parseInt(fields[2], 10);
      if (isNaN(pid) || isNaN(ppid) || isNaN(kib)) continue;

      rssMap.set(pid, kib * 1024);
      const children = childMap.get(ppid) ?? [];
      children.push(pid);
      childMap.set(ppid, children);
      etimeMap.set(pid, parseEtime(fields[3]));
    }
  } catch {
    // ps failure → return empty maps
  }
  return { rssMap, childMap, etimeMap };
}

export function parseEtime(s: string): number {
  let days = 0;
  const dashIdx = s.indexOf("-");
  if (dashIdx >= 0) {
    days = parseInt(s.slice(0, dashIdx), 10) || 0;
    s = s.slice(dashIdx + 1);
  }
  let total = 0;
  for (const p of s.split(":")) {
    total = total * 60 + (parseInt(p, 10) || 0);
  }
  return total + days * 86400;
}

function sumTreeRSS(
  pid: number,
  rssMap: Map<number, number>,
  childMap: Map<number, number[]>,
): number {
  let total = rssMap.get(pid) ?? 0;
  for (const child of childMap.get(pid) ?? []) {
    total += sumTreeRSS(child, rssMap, childMap);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatBytes(b: number): string {
  if (b >= 1 << 30) {
    const v = b / (1 << 30);
    return v >= 10 ? `${Math.round(v)}G` : `${v.toFixed(1)}G`;
  }
  if (b >= 1 << 20) return `${b >> 20}M`;
  if (b >= 1 << 10) return `${b >> 10}K`;
  return `${b}B`;
}

export function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export async function fetchPreview(
  name: string,
  lines: number,
): Promise<string> {
  if (lines < 1) lines = 1;

  const proc = Bun.spawn(["zmx", "history", name, "--vt"], {
    stdout: "pipe",
    stderr: "ignore",
  });

  const timeout = setTimeout(() => proc.kill(), 2000);
  try {
    const output = await new Response(proc.stdout).text();
    clearTimeout(timeout);
    await proc.exited;
    return tailLines(output, lines);
  } catch {
    clearTimeout(timeout);
    return "(preview unavailable: timed out)";
  }
}

function tailLines(text: string, maxLines: number): string {
  const all = text.split("\n").map(cleanForPreview);
  if (all.length <= maxLines) return all.join("\n");
  return all.slice(all.length - maxLines).join("\n");
}

/** Keep CSI sequences (colors/styles), strip everything else (OSC, charset, CR, control chars). */
function cleanForPreview(s: string): string {
  let result = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      i++;
      if (i >= s.length) break;
      if (s[i] === "[") {
        // CSI sequence — only keep SGR (ends with 'm' = colors/styles)
        let seq = "\x1b[";
        i++;
        while (i < s.length && (s.charCodeAt(i) < 0x40 || s.charCodeAt(i) > 0x7e)) {
          seq += s[i];
          i++;
        }
        if (i < s.length) {
          const finalByte = s[i];
          seq += finalByte;
          i++;
          if (finalByte === "m") {
            result += seq; // SGR only
          }
        }
      } else if (s[i] === "]") {
        // OSC — strip
        i++;
        while (i < s.length) {
          if (s[i] === "\x07") { i++; break; }
          if (s[i] === "\x1b" && i + 1 < s.length && s[i + 1] === "\\") { i += 2; break; }
          i++;
        }
      } else if (s[i] === "(" || s[i] === ")") {
        i++;
        if (i < s.length) i++;
      } else {
        i++;
      }
    } else if (s[i] === "\r") {
      i++;
    } else if (s.charCodeAt(i) < 0x20 && s[i] !== "\n" && s[i] !== "\t") {
      i++;
    } else {
      result += s[i];
      i++;
    }
  }
  return result;
}

export function scrollPreview(
  raw: string,
  offsetX: number,
  maxWidth: number,
): string {
  return raw
    .split("\n")
    .map((line) => {
      const runes = [...line];
      let skipped = 0;
      let runeIdx = 0;
      while (runeIdx < runes.length && skipped < offsetX) {
        skipped += stringWidth(runes[runeIdx]);
        runeIdx++;
      }
      const rest = runes.slice(runeIdx).join("");
      return fillRight(truncateStr(rest, maxWidth, ""), maxWidth);
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------

export function stripANSI(s: string): string {
  let result = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      i++;
      if (i >= s.length) break;
      switch (s[i]) {
        case "[": // CSI
          i++;
          while (i < s.length && (s.charCodeAt(i) < 0x40 || s.charCodeAt(i) > 0x7e))
            i++;
          if (i < s.length) i++;
          break;
        case "]": // OSC
          i++;
          while (i < s.length) {
            if (s[i] === "\x07") {
              i++;
              break;
            }
            if (s[i] === "\x1b" && i + 1 < s.length && s[i + 1] === "\\") {
              i += 2;
              break;
            }
            i++;
          }
          break;
        case "(":
        case ")":
          i++;
          if (i < s.length) i++;
          break;
        default:
          i++;
      }
    } else if (s[i] === "\r") {
      i++;
    } else if (s.charCodeAt(i) < 0x20 && s[i] !== "\n" && s[i] !== "\t") {
      i++;
    } else {
      result += s[i];
      i++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// String width utilities (wrapping string-width for runewidth equivalence)
// ---------------------------------------------------------------------------

export function strWidth(s: string): number {
  return stringWidth(s);
}

/** Truncate s to maxWidth display columns, appending tail if truncated. */
export function truncateStr(s: string, maxWidth: number, tail = "..."): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(s) <= maxWidth) return s;
  if (tail === "" || maxWidth <= tail.length) {
    // Truncate without ellipsis
    const chars = [...s];
    let width = 0;
    let end = 0;
    for (let i = 0; i < chars.length; i++) {
      const cw = stringWidth(chars[i]);
      if (width + cw > maxWidth) break;
      width += cw;
      end = i + 1;
    }
    return chars.slice(0, end).join("");
  }
  const target = maxWidth - tail.length;
  const chars = [...s];
  let width = 0;
  let end = 0;
  for (let i = 0; i < chars.length; i++) {
    const cw = stringWidth(chars[i]);
    if (width + cw > target) break;
    width += cw;
    end = i + 1;
  }
  return chars.slice(0, end).join("") + tail;
}

export function fillRight(s: string, width: number): string {
  const w = stringWidth(s);
  if (w >= width) return s;
  return s + " ".repeat(width - w);
}

export function padLeft(s: string, width: number): string {
  const w = stringWidth(s);
  if (w >= width) return s;
  return " ".repeat(width - w) + s;
}

export function padRight(s: string, width: number): string {
  return fillRight(s, width);
}

/**
 * ANSI-aware horizontal slice: extracts columns [startCol, startCol+width)
 * from a string that may contain CSI escape sequences.
 * All ANSI sequences are passed through (to preserve style state).
 * Appends a reset at the end to prevent style bleeding.
 */
export function ansiSlice(s: string, startCol: number, width: number): string {
  let out = "";
  let col = 0;
  let i = 0;

  while (i < s.length) {
    // ANSI CSI sequence — pass through SGR only (ends with 'm')
    if (s[i] === "\x1b" && i + 1 < s.length && s[i + 1] === "[") {
      let j = i + 2;
      while (j < s.length && (s.charCodeAt(j) < 0x40 || s.charCodeAt(j) > 0x7e)) j++;
      if (j < s.length) {
        if (s[j] === "m") {
          out += s.slice(i, j + 1);
        }
        j++;
      }
      i = j;
      continue;
    }

    // Printable character
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const charLen = ch.length;
    const w = stringWidth(ch);

    if (col >= startCol && col + w <= startCol + width) {
      out += ch;
    }
    col += w;
    i += charLen;

    if (col >= startCol + width) break;
  }

  out += "\x1b[0m"; // reset to prevent style bleeding into border/padding
  return out;
}

/** Measure the widest line in raw (unstyled) preview text. */
export function previewMaxWidth(raw: string): number {
  let maxW = 0;
  for (const line of raw.split("\n")) {
    const w = stringWidth(line);
    if (w > maxW) maxW = w;
  }
  return maxW;
}
