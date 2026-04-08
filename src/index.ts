#!/usr/bin/env bun
// index.ts — Entry point for zmx-sessions

import { run, type Cmd, type Msg, type Program } from "./tea";
import { newModel, fetchSessionsCmd } from "./tui/model";
import { update } from "./tui/update";
import { view } from "./tui/view";

declare const VERSION: string;
const version = typeof VERSION !== "undefined" ? VERSION : "dev";

// Handle --version / -v
if (process.argv.length > 2) {
  const arg = process.argv[2];
  if (arg === "-v" || arg === "--version") {
    console.log(`zmx-sessions ${version}`);
    process.exit(0);
  }
}

// Check zmx is available
const zmxPath = Bun.which("zmx");
if (!zmxPath) {
  console.error("Error: zmx not found in PATH");
  process.exit(1);
}

// Create the model and wire up the program
const model = newModel();

const program: Program = {
  init(): Cmd[] {
    return [fetchSessionsCmd()];
  },
  update(msg: Msg): Cmd[] {
    return update(model, msg);
  },
  view(): string {
    return view(model);
  },
};

// Run the TUI
await run(program);

// If the user pressed Enter to attach, exec into zmx attach
if (model.attachTarget) {
  const proc = Bun.spawn(["zmx", "attach", model.attachTarget], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
}
