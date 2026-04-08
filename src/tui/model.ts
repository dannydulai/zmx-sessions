// model.ts — Model state, enums, caching logic, and helper methods.

import type { Cmd, Msg } from "../tea.ts";
import {
  type Session,
  type ProcessInfo,
  strWidth,
  formatBytes,
  formatUptime,
  fetchSessions,
  fetchProcessInfo,
  fetchPreview,
  killSession,
} from "../zmx.ts";
import { tick } from "../tea.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LIST_MAX_OUTER_WIDTH = 56;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum State {
  Normal = 0,
  ConfirmKill = 1,
  Killing = 2,
  Filter = 3,
}

export enum SortMode {
  Name = 0,
  Clients = 1,
  PID = 2,
  Memory = 3,
  Uptime = 4,
}
export const SORT_MODE_COUNT = 5;

export function sortLabel(mode: SortMode): string {
  switch (mode) {
    case SortMode.Name:
      return "name";
    case SortMode.Clients:
      return "clients";
    case SortMode.PID:
      return "pid";
    case SortMode.Memory:
      return "memory";
    case SortMode.Uptime:
      return "uptime";
  }
}

// ---------------------------------------------------------------------------
// List column metrics
// ---------------------------------------------------------------------------

export interface ListMetrics {
  nameW: number;
  pidW: number;
  memW: number;
  uptimeW: number;
  clientW: number;
}

export function computeListMetrics(sessions: Session[]): ListMetrics {
  const m: ListMetrics = { nameW: 0, pidW: 1, memW: 1, uptimeW: 1, clientW: 2 };
  for (const s of sessions) {
    let w = strWidth(s.name);
    if (w > m.nameW) m.nameW = w;

    w = strWidth(s.pid);
    if (w > m.pidW) m.pidW = w;

    const memLabel = s.memory > 0 ? formatBytes(s.memory) : "-";
    w = strWidth(memLabel);
    if (w > m.memW) m.memW = w;

    const uptimeLabel = s.uptime > 0 ? formatUptime(s.uptime) : "-";
    w = strWidth(uptimeLabel);
    if (w > m.uptimeW) m.uptimeW = w;

    const clientLabel = `●${s.clients}`;
    w = strWidth(clientLabel);
    if (w > m.clientW) m.clientW = w;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface Model {
  sessions: Session[];
  cursor: number;
  listOffset: number;
  filterText: string;
  sortMode: SortMode;
  sortAsc: boolean;
  attachTarget: string;

  preview: string;
  previewScrollX: number;
  previewScrollY: number; // 0 = bottom (newest), positive = scrolled up
  state: State;
  status: string;

  // Kill tracking
  killQueue: string[];
  killNow: string;
  killDoneNames: string[];

  width: number;
  height: number;
  error: Error | null;

  // Caches
  _visibleCache: Session[] | null;
  _visibleMetrics: ListMetrics | null;
  _allMetrics: ListMetrics | null;
  _visibleDirty: boolean;
  _allMetricsDirty: boolean;
}

export function newModel(): Model {
  return {
    sessions: [],
    cursor: 0,
    listOffset: 0,
    filterText: "",
    sortMode: SortMode.Name,
    sortAsc: true,
    attachTarget: "",
    preview: "",
    previewScrollX: 0,
    previewScrollY: 0,
    state: State.Normal,
    status: "",
    killQueue: [],
    killNow: "",
    killDoneNames: [],
    width: 0,
    height: 0,
    error: null,
    _visibleCache: null,
    _visibleMetrics: null,
    _allMetrics: null,
    _visibleDirty: true,
    _allMetricsDirty: true,
  };
}

// ---------------------------------------------------------------------------
// Visibility / sorting cache
// ---------------------------------------------------------------------------

export function visibleSessions(m: Model): Session[] {
  if (!m._visibleDirty && m._visibleCache) return m._visibleCache;
  m._visibleCache = computeVisible(m);
  m._visibleMetrics = computeListMetrics(m._visibleCache);
  m._visibleDirty = false;
  return m._visibleCache;
}

export function visibleMetrics(m: Model): ListMetrics {
  visibleSessions(m); // ensure cache is fresh
  return m._visibleMetrics!;
}

export function allSessionMetrics(m: Model): ListMetrics {
  if (m._allMetricsDirty || !m._allMetrics) {
    m._allMetrics = computeListMetrics(m.sessions);
    m._allMetricsDirty = false;
  }
  return m._allMetrics;
}

export function markSessionsChanged(m: Model) {
  m._visibleDirty = true;
  m._allMetricsDirty = true;
}

export function markVisibleChanged(m: Model) {
  m._visibleDirty = true;
}

function computeVisible(m: Model): Session[] {
  let filtered: Session[];
  if (!m.filterText) {
    filtered = [...m.sessions];
  } else {
    const lower = m.filterText.toLowerCase();
    filtered = m.sessions.filter(
      (s) =>
        s.name.toLowerCase().includes(lower) ||
        s.startedIn.toLowerCase().includes(lower),
    );
  }

  const dir = m.sortAsc ? 1 : -1;
  filtered.sort((a, b) => {
    switch (m.sortMode) {
      case SortMode.Name:
        return dir * a.name.localeCompare(b.name);
      case SortMode.Clients:
        if (a.clients !== b.clients) return dir * (a.clients - b.clients);
        return a.name.localeCompare(b.name);
      case SortMode.PID: {
        const ai = parseInt(a.pid, 10);
        const bi = parseInt(b.pid, 10);
        if (ai !== bi) return dir * (ai - bi);
        return a.name.localeCompare(b.name);
      }
      case SortMode.Memory:
        if (a.memory !== b.memory) return dir * (a.memory - b.memory);
        return a.name.localeCompare(b.name);
      case SortMode.Uptime:
        if (a.uptime !== b.uptime) return dir * (a.uptime - b.uptime);
        return a.name.localeCompare(b.name);
    }
  });

  return filtered;
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

export function clampCursor(m: Model) {
  const visible = visibleSessions(m);
  if (m.cursor >= visible.length) m.cursor = Math.max(0, visible.length - 1);
  if (m.listOffset > m.cursor) m.listOffset = m.cursor;
}

export function ensureVisible(m: Model) {
  const h = mainContentHeight(m, 1);
  if (h <= 0) return;
  if (m.cursor < m.listOffset) m.listOffset = m.cursor;
  if (m.cursor >= m.listOffset + h) m.listOffset = m.cursor - h + 1;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function mainContentHeight(m: Model, helpLines: number): number {
  // 2 = top+bottom border of list/preview panes
  const h = m.height - 2 - helpLines;
  return h < 1 ? 1 : h;
}

export function listOuterWidth(m: Model): number {
  const n = m.sessions.length;
  const digits = String(n).length;
  const titleMin = 17 + digits + 11 + 4;

  const metrics = allSessionMetrics(m);
  let w =
    2 + metrics.nameW + 1 + metrics.pidW + 1 + metrics.memW + 1 +
    metrics.uptimeW + 1 + metrics.clientW + 2;
  if (w < titleMin) w = titleMin;
  if (w > LIST_MAX_OUTER_WIDTH) w = LIST_MAX_OUTER_WIDTH;
  const half = Math.floor(m.width / 2);
  if (w > half && half >= titleMin) w = half;
  return w;
}

export function listInnerWidth(m: Model): number {
  return listOuterWidth(m) - 2;
}

export function previewOuterWidth(m: Model): number {
  const w = m.width - listOuterWidth(m);
  return w < 10 ? 10 : w;
}

export function previewInnerWidth(m: Model): number {
  return previewOuterWidth(m) - 2;
}

// ---------------------------------------------------------------------------
// Kill targets
// ---------------------------------------------------------------------------

export function killTarget(m: Model): string | null {
  const visible = visibleSessions(m);
  if (m.cursor < visible.length) return visible[m.cursor].name;
  return null;
}

// ---------------------------------------------------------------------------
// Commands (async message producers)
// ---------------------------------------------------------------------------

export function fetchSessionsCmd(): Cmd {
  return async (): Promise<Msg> => {
    try {
      const sessions = await fetchSessions();
      return { type: "sessions", sessions };
    } catch (e) {
      return { type: "sessions", sessions: [], error: e as Error };
    }
  };
}

export function fetchProcessInfoCmd(sessions: Session[]): Cmd {
  return async (): Promise<Msg> => {
    const info = await fetchProcessInfo(sessions);
    return { type: "processInfo", info };
  };
}

export function fetchPreviewCmd(name: string, lines: number): Cmd {
  return async (): Promise<Msg> => {
    const content = await fetchPreview(name, lines);
    return { type: "preview", name, content };
  };
}

export function killOneCmd(name: string): Cmd {
  return async (): Promise<Msg> => {
    try {
      await killSession(name);
      return { type: "killOneResult", name };
    } catch (e) {
      return { type: "killOneResult", name, error: e as Error };
    }
  };
}

export function waitForGoneCmd(names: string[], attempt: number): Cmd {
  return async (): Promise<Msg> => {
    if (attempt >= 20) return { type: "allGone" };
    await new Promise((r) => setTimeout(r, 200));
    try {
      const sessions = await fetchSessions();
      const alive = new Set(sessions.map((s) => s.name));
      for (const name of names) {
        if (alive.has(name))
          return { type: "waitCheck", names, attempt: attempt + 1 };
      }
    } catch {
      // On error, consider them gone
    }
    return { type: "allGone" };
  };
}

export function clearStatusAfter(ms: number): Cmd {
  return tick(ms, () => ({ type: "statusClear" }));
}

// ---------------------------------------------------------------------------
// Preview command helper
// ---------------------------------------------------------------------------

export function previewCmd(m: Model): Cmd {
  const visible = visibleSessions(m);
  if (m.cursor >= visible.length) return null;
  // Fetch extra lines so the user can scroll vertically
  return fetchPreviewCmd(visible[m.cursor].name, 1000);
}
