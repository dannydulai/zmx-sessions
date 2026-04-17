#!/usr/bin/env bun
// index.ts — Entry point for z

import {
  ensureConfigDir,
  loadConfig,
  loadTabs,
  validateTabs,
  type Config,
  type LayoutTab,
  type LayoutPane,
} from "./config.ts";
import {
  listSessions,
  uniqueTabs,
  panesForTab,
  mooxAttach,
  kittyLaunchMoox,
  kittyAttachMoox,
  resolveDir,
  timeAgo,
  type MooxSession,
} from "./moox.ts";
import { showPicker, REFRESH, type PanelItem, type PickerData, type NeedsDirFn } from "./ui/render.tsx";
import { basename } from "path";

// Nerd font icons
const I_NEW = "\uf067";
const I_TAB = "\ueea8";
const I_PANE = "\uf489";
const I_DISCONNECTED = "\uf444";

function dn(name: string): string {
  return name.replace(/_/g, " ");
}

function runningPaneIcon(s: MooxSession): string {
  return s.clients === 0 ? I_DISCONNECTED : I_PANE;
}

function runningPaneSuffix(s: MooxSession): string | undefined {
  const ago = timeAgo(s.created);
  const parts: string[] = [];
  if (ago) parts.push(ago);
  if (s.clients === 0) parts.push("[disconnected]");
  else if (s.clients > 1) parts.push(`[${s.clients} attached]`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

// Display name for TUI: display > name > cmd > "Shell"
function paneDisplay(p: LayoutPane): string {
  if (p.display) return p.display;
  if (p.name) return p.name;
  if (p.cmd) return p.cmd;
  return "Shell";
}

// Name for moox var: name > "Shell"
function paneName(p: LayoutPane): string {
  if (p.name) return p.name;
  return "Shell";
}

// ---------------------------------------------------------------------------
// Kitty tab title
// ---------------------------------------------------------------------------

async function getKittyTabTitle(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["kitty", "@", "ls", "--self"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const data = JSON.parse(output);
    const tab = data?.[0]?.tabs?.[0];
    if (!tab || !tab.title_overridden) return null;
    return tab.title || null;
  } catch {
    return null;
  }
}

async function setKittyTabTitle(title: string): Promise<void> {
  const proc = Bun.spawn(["kitty", "@", "set-tab-title", title], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

async function setKittyWindowTitle(title: string): Promise<void> {
  const proc = Bun.spawn(["kitty", "@", "set-window-title", title], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

// ---------------------------------------------------------------------------
// Layout validation
// ---------------------------------------------------------------------------

async function loadValidatedTabs(): Promise<LayoutTab[]> {
  while (true) {
    const tabs = loadTabs();
    const errors = validateTabs(tabs);
    if (errors.length === 0) return tabs;

    process.stdout.write("\x1b[91m");
    for (const e of errors) {
      process.stdout.write(`Error: ${e}\n`);
    }
    process.stdout.write("\x1b[0m");
    process.stdout.write("\n\x1b[97mFix your layout config and press any key to reload...\x1b[0m");
    await waitForKey();
    process.stdout.write("\n\n");
  }
}

// ---------------------------------------------------------------------------
// Dir resolution
// ---------------------------------------------------------------------------

function checkDirNeedsInput(dir: string | undefined): { needs: boolean; initial: string } | null {
  if (!dir) return null;
  if (dir === "ask") return { needs: true, initial: process.cwd() };
  const resolved = resolveDir(dir) ?? dir;
  const { existsSync } = require("fs");
  if (existsSync(resolved)) return null;
  return { needs: true, initial: resolved };
}

function makeNeedsDirFn(tabs: LayoutTab[]): NeedsDirFn {
  return (value: string) => {
    if (value === "new:" || value === "new-shell:") {
      return checkDirNeedsInput(config.default.dir);
    }
    const [kind, name] = parseWhat(value);
    if (kind === "layout-tab") {
      const { tab } = findLayoutTab(tabs, name);
      return checkDirNeedsInput(tab.dir);
    }
    if (kind === "layout-pane") {
      const { pane, tab } = findLayoutPane(tabs, name);
      return checkDirNeedsInput(pane.dir ?? tab.dir);
    }
    return null;
  };
}

function resolvePickerDir(dir: string | undefined, configDir: string | undefined): string {
  if (dir) return dir;
  if (configDir && configDir !== "ask") {
    const resolved = resolveDir(configDir);
    if (resolved) return resolved;
  }
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (!Bun.which("moox")) {
  console.error("Error: moox not found in PATH");
  process.exit(1);
}

ensureConfigDir();
const config = loadConfig();

if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
  printHelp();
  process.exit(0);
}

const cmd = args[0];

if (cmd === "new") {
  await handleNew(args.slice(1));
} else if (cmd === "ls" || cmd === "l") {
  await handleLs(args.slice(1));
} else {
  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// z new
// ---------------------------------------------------------------------------

async function handleNew(args: string[]) {
  // z new pane [what]
  if (args[0] === "pane") {
    const tabName = await resolveTabName();
    if (!tabName) {
      // No tab context — fall through to full picker
      const what = args[1];
      if (what) await execNewWhat(what);
      await pickerNew();
      return;
    }
    const what = args[1];
    if (what) await execNewPaneWhat(tabName, what);
    await pickerNewPane(tabName);
    return;
  }

  // z new [what]
  const what = args[0];
  if (what) await execNewWhat(what);

  // If kitty tab has a title, go to pane picker
  const tabName = await getKittyTabTitle();
  if (tabName) {
    await pickerNewPane(tabName);
  } else {
    await pickerNew();
  }
}

// Try to get tab name from kitty environment
async function resolveTabName(): Promise<string | null> {
  return getKittyTabTitle();
}

// ---------------------------------------------------------------------------
// z new <what> — direct execution
// ---------------------------------------------------------------------------

async function execNewWhat(what: string, pickerDir?: string) {
  const [kind, name] = parseWhat(what);
  const tabs = await loadValidatedTabs();

  switch (kind) {
    case "new": {
      await setKittyTabTitle(name);
      await attachAndExit(undefined, undefined, undefined, { tab: name, pane: "Shell" });
      break;
    }
    case "layout-tab": {
      const { tab } = findLayoutTab(tabs, name);
      const dir = resolvePickerDir(pickerDir, tab.dir);
      const tabName = basename(dir);
      await setKittyTabTitle(tabName);
      for (let i = 1; i < tab.panes.length; i++) {
        const p = tab.panes[i];
        const pdir = p.dir && p.dir !== "ask" ? (resolveDir(p.dir) ?? dir) : dir;
        const cmd = p.cmd || undefined;
        await kittyLaunchMoox(cmd, pdir, { tab: tabName, pane: paneName(p) });
      }
      if (tab.panes.length > 0) {
        const p = tab.panes[0];
        const cmd = p.cmd || undefined;
        const pdir = p.dir && p.dir !== "ask" ? (resolveDir(p.dir) ?? dir) : dir;
        await attachAndExit(undefined, cmd, pdir, { tab: tabName, pane: paneName(p) }, p.name || undefined);
      }
      break;
    }
    case "layout-pane": {
      const { pane, tab } = findLayoutPane(tabs, name);
      const dir = resolvePickerDir(pickerDir, pane.dir ?? tab.dir);
      const cmd = pane.cmd || undefined;
      const tabName = basename(dir);
      await setKittyTabTitle(tabName);
      await attachAndExit(undefined, cmd, dir, { tab: tabName, pane: paneName(pane) }, pane.name || undefined);
      break;
    }
    case "existing-tab": {
      const sessions = await listSessions();
      const tabSessions = panesForTab(sessions, name);
      if (tabSessions.length === 0) {
        console.error(`No running sessions in tab: ${name}`);
        process.exit(1);
      }
      for (let i = 1; i < tabSessions.length; i++) {
        await kittyAttachMoox(tabSessions[i].id, tabSessions[i].pane || undefined);
      }
      await attachAndExit(tabSessions[0].id, undefined, undefined, undefined, tabSessions[0].pane || undefined);
      break;
    }
    case "existing-pane": {
      const allSessions = await listSessions();
      const session = allSessions.find((s) => s.id === name);
      await attachAndExit(name, undefined, undefined, undefined, session?.pane || undefined);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// z new pane <tab> <what> — direct execution
// ---------------------------------------------------------------------------

async function execNewPaneWhat(tabName: string, what: string, pickerDir?: string) {
  const [kind, name] = parseWhat(what);
  const tabs = await loadValidatedTabs();

  switch (kind) {
    case "new": {
      await attachAndExit(undefined, undefined, undefined, { tab: tabName, pane: name });
      break;
    }
    case "layout-tab": {
      const { tab } = findLayoutTab(tabs, name);
      const dir = resolvePickerDir(pickerDir, tab.dir);
      const tabName = basename(dir);
      await setKittyTabTitle(tabName);
      for (let i = 1; i < tab.panes.length; i++) {
        const p = tab.panes[i];
        const pdir = p.dir && p.dir !== "ask" ? (resolveDir(p.dir) ?? dir) : dir;
        const cmd = p.cmd || undefined;
        await kittyLaunchMoox(cmd, pdir, { tab: tabName, pane: paneName(p) });
      }
      if (tab.panes.length > 0) {
        const p = tab.panes[0];
        const cmd = p.cmd || undefined;
        const pdir = p.dir && p.dir !== "ask" ? (resolveDir(p.dir) ?? dir) : dir;
        await attachAndExit(undefined, cmd, pdir, { tab: tabName, pane: paneName(p) }, p.name || undefined);
      }
      break;
    }
    case "layout-pane": {
      const { pane, tab } = findLayoutPane(tabs, name);
      const dir = resolvePickerDir(pickerDir, pane.dir ?? tab.dir);
      const cmd = pane.cmd || undefined;
      await attachAndExit(undefined, cmd, dir, { tab: tabName, pane: paneName(pane) }, pane.name || undefined);
      break;
    }
    case "existing-tab": {
      const sessions = await listSessions();
      const tabSessions = panesForTab(sessions, name);
      if (tabSessions.length === 0) {
        console.error(`No running sessions in tab: ${name}`);
        process.exit(1);
      }
      for (let i = 1; i < tabSessions.length; i++) {
        await kittyAttachMoox(tabSessions[i].id, tabSessions[i].pane || undefined);
      }
      await attachAndExit(tabSessions[0].id, undefined, undefined, undefined, tabSessions[0].pane || undefined);
      break;
    }
    case "existing-pane": {
      const sessions = await listSessions();
      const session = sessions.find((s) => s.id === name);
      await attachAndExit(name, undefined, undefined, undefined, session?.pane || undefined);
      break;
    }
    default:
      console.error(`Invalid what for 'z new pane': ${what}`);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// z new — interactive picker
// ---------------------------------------------------------------------------

async function buildPickerNewData(): Promise<PickerData> {
  const layoutTabs = await loadValidatedTabs();
  const sessions = await listSessions();

  const layoutItems: PanelItem[] = [];
  layoutItems.push({ label: "", value: "", selectable: false });
  layoutItems.push({ label: `${I_NEW} New Shell...`, value: "new:", type: "new" });

  for (const tab of layoutTabs) {
    layoutItems.push({ label: "", value: "", selectable: false });
    layoutItems.push({
      label: `${I_TAB} ${dn(tab.name)}`,
      value: `layout-tab:${tab.name}`,
      type: "tab",
    });
    for (const pane of tab.panes) {
      layoutItems.push({
        label: `${I_PANE} ${dn(paneDisplay(pane))}`,
        value: `layout-pane:${tab.name}.${pane.name}`,
        type: "pane",
        indent: 1,
      });
    }
  }
  layoutItems.push({ label: "", value: "", selectable: false });
  layoutItems.push({ label: `${I_NEW} Raw Shell`, value: "shell:", type: "new" });

  const runningItems: PanelItem[] = [];
  const rTabs = uniqueTabs(sessions);
  for (const tabName of rTabs) {
    const tabPanes = panesForTab(sessions, tabName);
    runningItems.push({ label: "", value: "", selectable: false });
    runningItems.push({
      label: `${I_TAB} ${dn(tabName)}`,
      value: `existing-tab:${tabName}`,
      type: "tab",
    });
    for (const s of tabPanes) {
      runningItems.push({
        label: `${runningPaneIcon(s)} ${dn(s.pane)}`,
        suffix: runningPaneSuffix(s),
        id: s.id,
        value: `existing-pane:${s.id}`,
        type: "pane",
        indent: 1,
      });
    }
  }

  return { layoutItems, runningItems };
}

async function pickerNew() {
  while (true) {
    const data = await buildPickerNewData();
    const tabs = await loadValidatedTabs();
    const ndFn = makeNeedsDirFn(tabs);

    const result = await showPicker(data, buildPickerNewData, config.colors, "z", ndFn);

    if (result.choice === REFRESH) continue;
    if (!result.choice) break;

    if (result.choice === "new:") {
      const dir = result.dir ?? process.cwd();
      const tabName = basename(dir);
      const pn = config.default.name || "Shell";
      await setKittyTabTitle(tabName);
      await attachAndExit(undefined, config.default.cmd, dir, { tab: tabName, pane: pn }, config.default.name);
      continue;
    }

    if (result.choice === "shell:") {
      const shell = process.env.SHELL ?? "/bin/sh";
      const proc = Bun.spawn([shell], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      process.exit(await proc.exited);
    }

    await execNewWhat(result.choice, result.dir);
  }
}

// ---------------------------------------------------------------------------
// z new pane — interactive picker
// ---------------------------------------------------------------------------

function buildPickerPaneData(tabName: string) {
  return async (): Promise<PickerData> => {
    const layoutTabs = await loadValidatedTabs();
    const sessions = await listSessions();

    const layoutItems: PanelItem[] = [];
    layoutItems.push({ label: "", value: "", selectable: false });
    layoutItems.push({ label: `${I_NEW} New Shell`, value: "new-shell:", type: "new" });

    for (const tab of layoutTabs) {
      layoutItems.push({ label: "", value: "", selectable: false });
      layoutItems.push({
        label: `${I_TAB} ${dn(tab.name)}`,
        value: `layout-tab:${tab.name}`,
        type: "tab",
      });
      for (const pane of tab.panes) {
        layoutItems.push({
          label: `${I_PANE} ${dn(paneDisplay(pane))}`,
          value: `layout-pane:${tab.name}.${pane.name}`,
          type: "pane",
          indent: 1,
        });
      }
    }
    layoutItems.push({ label: "", value: "", selectable: false });
    layoutItems.push({ label: `${I_NEW} Raw Shell`, value: "shell:", type: "new" });

    const runningItems: PanelItem[] = [];
    // Sort current tab first
    const sorted = [...sessions].sort((a, b) => {
      const aMatch = a.tab === tabName ? 0 : 1;
      const bMatch = b.tab === tabName ? 0 : 1;
      return aMatch - bMatch;
    });
    const seenTabs = new Set<string>();
    for (const s of sorted) {
      if (!seenTabs.has(s.tab)) {
        seenTabs.add(s.tab);
        runningItems.push({ label: "", value: "", selectable: false });
        runningItems.push({
          label: `${I_TAB} ${dn(s.tab)}`,
          value: "",
          selectable: false,
          type: "tab",
        });
      }
      runningItems.push({
        label: `${runningPaneIcon(s)} ${dn(s.pane)}`,
        suffix: runningPaneSuffix(s),
        id: s.id,
        value: `existing-pane:${s.id}`,
        type: "pane",
        indent: 1,
      });
    }

    return { layoutItems, runningItems, leftTitle: dn(tabName) };
  };
}

async function pickerNewPane(tabName: string) {
  const refreshFn = buildPickerPaneData(tabName);
  while (true) {
    const data = await refreshFn();
    const tabs = await loadValidatedTabs();
    const ndFn = makeNeedsDirFn(tabs);

    const result = await showPicker(data, refreshFn, config.colors, `z \u2014 ${dn(tabName)}`, ndFn);

    if (result.choice === REFRESH) continue;
    if (!result.choice) break;

    if (result.choice === "new-shell:") {
      const pn = config.default.name || "Shell";
      await attachAndExit(undefined, config.default.cmd, result.dir, { tab: tabName, pane: pn }, config.default.name);
      continue;
    }

    if (result.choice === "new:" && result.name) {
      await attachAndExit(undefined, undefined, undefined, { tab: tabName, pane: result.name });
      continue;
    }

    if (result.choice === "shell:") {
      const shell = process.env.SHELL ?? "/bin/sh";
      const proc = Bun.spawn([shell], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      process.exit(await proc.exited);
    }

    await execNewPaneWhat(tabName, result.choice, result.dir);
  }
}

// ---------------------------------------------------------------------------
// z ls
// ---------------------------------------------------------------------------

async function handleLs(args: string[]) {
  const what = args[0];
  if (!what) {
    console.error("Usage: z ls <layouts|tabs|panes>");
    process.exit(1);
  }

  if (what === "layouts") {
    const tabs = loadTabs();
    if (tabs.length === 0) {
      console.log("No layouts defined.");
      return;
    }
    for (const tab of tabs) {
      console.log(`${tab.name}${tab.dir ? ` (${tab.dir})` : ""}`);
      for (const pane of tab.panes) {
        const cmd = pane.cmd ?? config.default.cmd ?? "$SHELL";
        console.log(`  ${pane.name} → ${cmd}`);
      }
    }
  } else if (what === "tabs") {
    const sessions = await listSessions();
    const tabs = uniqueTabs(sessions);
    if (tabs.length === 0) {
      console.log("No running tabs.");
      return;
    }
    for (const tabName of tabs) {
      const panes = panesForTab(sessions, tabName);
      console.log(`${tabName} (${panes.map((p) => p.pane).join(", ")})`);
    }
  } else if (what === "panes") {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log("No running panes.");
      return;
    }
    for (const s of sessions) {
      console.log(`${s.id}  ${s.tab}/${s.pane}`);
    }
  } else {
    console.error(`Unknown: ${what}. Use: layouts, tabs, panes`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`z — terminal workspace manager backed by moox

Usage:
  z new [what]                 Open a new or existing session
  z new pane [what]            Open a pane in the current tab
  z ls layouts                 List configured layouts
  z ls tabs                    List running tabs
  z ls panes                   List running panes
  z help                       Show this help

What specifiers:
  new:<name>                   Create new tab/pane with default command
  layout-tab:<name>            Start all panes from a layout tab
  layout-pane:<tab>.<pane>     Start a specific layout pane
  existing-tab:<name>          Open all panes of a running tab
  existing-pane:<id>           Attach to a specific running pane

Without a specifier, an interactive picker is shown.

Config: ${configDirDisplay()}/
  config.yaml                  Default command, settings
  layouts.yaml                 Layout definitions
  layouts.d/*.yaml             Additional layout files`);
}

function configDirDisplay(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return `${xdg}/z`;
  return "~/.config/z";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseWhat(what: string): [string, string] {
  const colon = what.indexOf(":");
  if (colon < 0) return ["new", what];
  return [what.slice(0, colon), what.slice(colon + 1)];
}

function findLayoutTab(
  tabs: LayoutTab[],
  name: string,
): { tab: LayoutTab } {
  const tab = tabs.find((t) => t.name === name);
  if (!tab) {
    console.error(`Tab not found: ${name}`);
    process.exit(1);
  }
  return { tab };
}

function findLayoutPane(
  tabs: LayoutTab[],
  name: string,
): { pane: LayoutPane; tab: LayoutTab } {
  const dot = name.indexOf(".");
  const tabName = dot >= 0 ? name.slice(0, dot) : name;
  const pnName = dot >= 0 ? name.slice(dot + 1) : "";
  const tab = tabs.find((t) => t.name === tabName);
  if (!tab) {
    console.error(`Tab not found: ${tabName}`);
    process.exit(1);
  }
  const pane = pnName
    ? tab.panes.find((p) => p.name === pnName)
    : tab.panes[0];
  if (!pane) {
    console.error(`Pane not found: ${pnName}`);
    process.exit(1);
  }
  return { pane, tab };
}

async function attachAndExit(
  id?: string,
  command?: string,
  dir?: string,
  vars?: Record<string, string>,
  windowTitle?: string,
): Promise<void> {
  if (windowTitle) await setKittyWindowTitle(dn(windowTitle));
  const exitCode = await mooxAttach(id, command, dir, vars);
  process.exit(exitCode);
}

function waitForKey(): Promise<void> {
  return new Promise((resolve) => {
    const isRaw = process.stdin.isTTY;
    if (isRaw) process.stdin.setRawMode(true);
    process.stdin.resume();
    const drain = () => { process.stdin.read(); };
    drain();
    setTimeout(() => {
      drain();
      const onData = () => {
        process.stdin.off("data", onData);
        if (isRaw) process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve();
      };
      process.stdin.on("data", onData);
    }, 50);
  });
}
