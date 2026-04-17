// moox.ts — Interactions with the moox CLI

export interface MooxSession {
  id: string;
  tab: string;
  pane: string;
  created: number;
  clients: number;
}

export async function listSessions(): Promise<MooxSession[]> {
  const proc = Bun.spawn(["moox", "list", "-j"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return [];

  let data: any[];
  try {
    data = JSON.parse(output);
  } catch {
    return [];
  }

  const sessions: MooxSession[] = [];
  for (const entry of data) {
    // Only show sessions that have a tab var (z-managed)
    if (!entry.tab) continue;
    sessions.push({
      id: entry.id ?? "",
      tab: entry.tab ?? "",
      pane: entry.pane ?? "",
      created: entry.created ?? 0,
      clients: entry.clients ?? 0,
    });
  }

  return sessions;
}

export async function mooxSetVars(
  id: string,
  vars: Record<string, string>,
): Promise<void> {
  const args = ["moox", "vars", id];
  for (const [k, v] of Object.entries(vars)) {
    args.push("--var", `${k}=${v}`);
  }
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

export async function mooxKill(id: string): Promise<void> {
  const proc = Bun.spawn(["moox", "kill", id], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

// Get unique tab names from running sessions
export function uniqueTabs(sessions: MooxSession[]): string[] {
  const seen = new Set<string>();
  for (const s of sessions) seen.add(s.tab);
  return [...seen].sort();
}

// Get panes for a specific tab (by tab name)
export function panesForTab(
  sessions: MooxSession[],
  tab: string,
): MooxSession[] {
  return sessions.filter((s) => s.tab === tab);
}

// Format a unix timestamp as human-readable "ago" string
export function timeAgo(created: number): string {
  if (!created) return "";
  const now = Math.floor(Date.now() / 1000);
  const diff = now - created;
  if (diff < 0) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  const d = new Date(created * 1000);
  const month = d.toLocaleString("en", { month: "short" });
  const day = d.getDate();
  const year = d.getFullYear();
  const thisYear = new Date().getFullYear();
  if (year === thisYear) return `${month} ${day}`;
  return `${month} ${day}, ${year}`;
}

// Attach to a session (creates it if needed with the given command)
// If id is provided, attaches to existing. If not, creates new.
export async function mooxAttach(
  id?: string,
  command?: string,
  dir?: string,
  vars?: Record<string, string>,
): Promise<number> {
  const args = ["moox", "attach"];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      args.push("--var", `${k}=${v}`);
    }
  }
  if (id) {
    args.push(id);
  } else {
    args.push("-");
  }
  if (command !== undefined) {
    args.push(...shellCmd(command));
  }
  const opts: any = {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  };
  if (dir) opts.cwd = dir;
  const proc = Bun.spawn(args, opts);
  return proc.exited;
}

// Launch a moox attach in a new kitty window
export async function kittyLaunchMoox(
  command?: string,
  dir?: string,
  vars?: Record<string, string>,
): Promise<number> {
  const shell = process.env.SHELL ?? "/bin/sh";
  const varArgs = vars ? Object.entries(vars).map(([k, v]) => `--var ${k}=${v}`).join(" ") : "";
  const cmdPart = command ? `- ${shell} -c ${shellQuote(command)}` : "-";
  const mooxCmd = `moox attach ${varArgs} ${cmdPart}`.trim().replace(/  +/g, " ");
  const paneTitle = vars?.pane ? `kitty @ set-window-title ${shellQuote(vars.pane.replace(/_/g, " "))}; ` : "";
  const args = [
    "kitty", "@", "launch",
    "--env", "SHLVL=0",
    "--cwd", dir ?? process.cwd(),
    shell, "-lc", `${paneTitle}${mooxCmd}`,
  ];
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  return proc.exited;
}

// Launch a moox attach to an existing session in a new kitty window
export async function kittyAttachMoox(id: string, windowTitle?: string): Promise<number> {
  const shell = process.env.SHELL ?? "/bin/sh";
  const titleCmd = windowTitle ? `kitty @ set-window-title ${shellQuote(windowTitle)}; ` : "";
  const args = [
    "kitty", "@", "launch",
    "--env", "SHLVL=0",
    shell, "-lc", `${titleCmd}moox attach ${id}`,
  ];
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  return proc.exited;
}

// Launch a z command in a new kitty window
export async function kittyLaunch(
  zArgs: string,
  dir?: string,
): Promise<number> {
  const shell = process.env.SHELL ?? "/bin/sh";
  const zBin = process.argv[1];
  const cwd = dir ?? process.cwd();
  const cmd = `bun run ${zBin} ${zArgs}`;
  const args = [
    "kitty", "@", "launch",
    "--env", "SHLVL=0",
    "--cwd", cwd,
    shell, "-lc", cmd,
  ];
  const proc = Bun.spawn(args, {
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exited;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function shellCmd(command: string | undefined): string[] {
  const shell = process.env.SHELL ?? "/bin/sh";
  if (!command) return [shell];
  return [shell, "-c", command];
}

// Resolve $SHELL and ~ in command strings
export function resolveCommand(cmd: string): string {
  if (cmd === "$SHELL") {
    return process.env.SHELL ?? "/bin/sh";
  }
  return cmd;
}

// Expand ~ in directory paths
export function resolveDir(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  if (dir.startsWith("~/")) {
    return process.env.HOME + dir.slice(1);
  }
  return dir;
}
