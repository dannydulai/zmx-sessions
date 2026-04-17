// config.ts — Config and layout loading from XDG_CONFIG_HOME/z/

import { parse as parseYaml } from "yaml";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync, readdirSync } from "fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StyleSpec {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
}

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
}

export interface Colors {
  tab: Style;
  pane: Style;
  new: Style;
  running: Style;
  selection: Style;
}

export interface DefaultPane {
  name?: string;
  cmd?: string;
  dir?: string; // fixed path, "ask", or undefined (cwd)
}

export interface Config {
  default: DefaultPane;
  colors: Colors;
}

export interface LayoutPane {
  name: string;
  display?: string;
  cmd?: string;
  dir?: string;
}

export interface LayoutTab {
  name: string;
  dir?: string;
  panes: LayoutPane[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "z");
  return join(homedir(), ".config", "z");
}

function configPath(): string {
  return join(configDir(), "config.yaml");
}

function layoutsPath(): string {
  return join(configDir(), "layouts.yaml");
}

function layoutsDDir(): string {
  return join(configDir(), "layouts.d");
}

// ---------------------------------------------------------------------------
// Init — create dirs and default config if missing
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = `# z configuration

# Default pane settings for "New Shell" menu items
#   name: kitty window title and moox pane var (omit to not set)
#   cmd:  command to run (omit for login shell)
#   dir:  "ask" to prompt, or a fixed path (omit for cwd)
default:
  name: Shell
`;

export function ensureConfigDir(): void {
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const ld = layoutsDDir();
  if (!existsSync(ld)) {
    mkdirSync(ld, { recursive: true });
  }
  const cp = configPath();
  if (!existsSync(cp)) {
    Bun.write(cp, DEFAULT_CONFIG);
  }
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const DEFAULT_STYLES: Record<string, string | StyleSpec> = {
  tab: "yellow",
  pane: "green",
  new: "cyan",
  running: { dim: true },
  selection: { bg: "blue", fg: "white", bold: true },
};

// ---------------------------------------------------------------------------
// Color / style resolution
// ---------------------------------------------------------------------------

const INK_COLOR_MAP: Record<string, string> = {
  "bright black": "blackBright",
  "bright red": "redBright",
  "bright green": "greenBright",
  "bright yellow": "yellowBright",
  "bright blue": "blueBright",
  "bright magenta": "magentaBright",
  "bright purple": "magentaBright",
  "bright cyan": "cyanBright",
  "bright white": "whiteBright",
  "purple": "magenta",
};

function normalizeColor(color: string): string {
  if (color.startsWith("#") && color.length === 4) {
    const h = color.slice(1);
    return "#" + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  return INK_COLOR_MAP[color] ?? color;
}

function normalizeStyle(spec: string | StyleSpec): Style {
  if (typeof spec === "string") {
    return { fg: normalizeColor(spec) };
  }
  return {
    fg: spec.fg ? normalizeColor(spec.fg) : undefined,
    bg: spec.bg ? normalizeColor(spec.bg) : undefined,
    bold: spec.bold,
    italic: spec.italic,
    dim: spec.dim,
    strikethrough: spec.strikethrough,
  };
}

function resolveAllColors(raw: any): Colors {
  return {
    tab: normalizeStyle(raw.tab ?? DEFAULT_STYLES.tab),
    pane: normalizeStyle(raw.pane ?? DEFAULT_STYLES.pane),
    new: normalizeStyle(raw.new ?? DEFAULT_STYLES.new),
    running: normalizeStyle(raw.running ?? DEFAULT_STYLES.running),
    selection: normalizeStyle(raw.selection ?? DEFAULT_STYLES.selection),
  };
}

function parseDefault(raw: any): DefaultPane {
  if (!raw) return {};
  return {
    name: raw.name || undefined,
    cmd: raw.cmd || undefined,
    dir: raw.dir || undefined,
  };
}

export function loadConfig(): Config {
  const cp = configPath();
  if (!existsSync(cp)) {
    return {
      default: parseDefault(null),
      colors: resolveAllColors({}),
    };
  }
  const text = require("fs").readFileSync(cp, "utf-8") as string;
  const doc = parseYaml(text) || {};
  const rawColors = doc.colors ?? {};
  return {
    default: parseDefault(doc.default),
    colors: resolveAllColors(rawColors),
  };
}

// ---------------------------------------------------------------------------
// Layout loading
// ---------------------------------------------------------------------------

function parseTabsFromYaml(text: string): LayoutTab[] {
  const doc = parseYaml(text);
  if (!doc) return [];
  const raw = Array.isArray(doc) ? doc : doc.tabs ?? [];
  return raw.map(parseTab).filter((t): t is LayoutTab => t !== null);
}

function parseTab(raw: any): LayoutTab | null {
  if (!raw) return null;
  const panes: LayoutPane[] = (raw.panes ?? [{}]).map((p: any) => {
    if (typeof p === "string") return { name: p };
    return {
      name: p.name ?? "",
      display: p.display,
      cmd: p.cmd,
      dir: p.dir,
    };
  });
  return {
    name: raw.name ?? "tab",
    dir: raw.dir,
    panes,
  };
}

export function loadTabs(): LayoutTab[] {
  const tabs: LayoutTab[] = [];

  // layouts.yaml
  const lp = layoutsPath();
  if (existsSync(lp)) {
    const text = require("fs").readFileSync(lp, "utf-8") as string;
    tabs.push(...parseTabsFromYaml(text));
  }

  // layouts.d/*.yaml
  const ld = layoutsDDir();
  if (existsSync(ld)) {
    const files = readdirSync(ld).filter(
      (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
    );
    for (const f of files.sort()) {
      const text = require("fs").readFileSync(join(ld, f), "utf-8") as string;
      tabs.push(...parseTabsFromYaml(text));
    }
  }

  return tabs;
}

// Check for naming conflicts. Returns error messages, or empty array if ok.
export function validateTabs(tabs: LayoutTab[]): string[] {
  const errors: string[] = [];

  // Check for spaces in names
  for (const t of tabs) {
    if (t.name.includes(" ")) {
      errors.push(`Tab name "${t.name}" contains spaces. Use _ instead (displayed as spaces).`);
    }
    for (const p of t.panes) {
      if (p.name.includes(" ")) {
        errors.push(`Pane name "${p.name}" in tab "${t.name}" contains spaces. Use _ instead (displayed as spaces).`);
      }
    }
  }

  // Check for duplicate tab names
  const tabNames = new Map<string, number>();
  for (const t of tabs) {
    tabNames.set(t.name, (tabNames.get(t.name) ?? 0) + 1);
  }
  for (const [name, count] of tabNames) {
    if (count > 1) {
      errors.push(`Duplicate tab name: "${name}" (appears ${count} times)`);
    }
  }

  return errors;
}
