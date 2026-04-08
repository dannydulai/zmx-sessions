// tea.ts — Lightweight Bubble Tea-like terminal UI runtime for Bun.

// Key code constants
export const KeyUp = "up";
export const KeyDown = "down";
export const KeyLeft = "left";
export const KeyRight = "right";
export const KeyEnter = "enter";
export const KeySpace = "space";
export const KeyEscape = "escape";
export const KeyBackspace = "backspace";
export const KeyPgUp = "pgup";
export const KeyPgDn = "pgdn";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type KeyPressMsg = {
  type: "keypress";
  code: string; // KeyUp/KeyDown/... or the character itself
  text: string; // printable text (empty for special keys)
  mod: { ctrl: boolean };
};

export type WindowSizeMsg = {
  type: "windowSize";
  width: number;
  height: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Msg = KeyPressMsg | WindowSizeMsg | { type: string; [key: string]: any };

export type Cmd = (() => Promise<Msg>) | null;

export const quitCmd: Cmd = () => Promise.resolve({ type: "quit" });

// ---------------------------------------------------------------------------
// Program interface — implement this to build a TUI app
// ---------------------------------------------------------------------------

export interface Program {
  init(): Cmd[];
  update(msg: Msg): Cmd[];
  view(): string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function batch(...cmds: (Cmd | null | undefined)[]): Cmd[] {
  return cmds.filter((c): c is NonNullable<Cmd> => c != null);
}

export function tick(ms: number, fn: () => Msg): Cmd {
  return () => new Promise((resolve) => setTimeout(() => resolve(fn()), ms));
}

// ---------------------------------------------------------------------------
// Input parser — converts raw stdin bytes into KeyPressMsg[]
// ---------------------------------------------------------------------------

function parseInput(data: Buffer): KeyPressMsg[] {
  const msgs: KeyPressMsg[] = [];
  const bytes = new Uint8Array(data);
  let i = 0;

  while (i < bytes.length) {
    const b = bytes[i];

    // ESC sequences
    if (b === 0x1b) {
      if (i + 2 < bytes.length && bytes[i + 1] === 0x5b) {
        // CSI sequence: ESC [ (params) (final)
        i += 2; // skip ESC [
        let params = "";
        while (i < bytes.length && bytes[i] >= 0x30 && bytes[i] <= 0x3f) {
          params += String.fromCharCode(bytes[i]);
          i++;
        }
        if (i >= bytes.length) continue;
        const finalByte = bytes[i];
        i++;

        if (!params) {
          if (finalByte === 0x41) { msgs.push(key(KeyUp)); continue; }
          if (finalByte === 0x42) { msgs.push(key(KeyDown)); continue; }
          if (finalByte === 0x43) { msgs.push(key(KeyRight)); continue; }
          if (finalByte === 0x44) { msgs.push(key(KeyLeft)); continue; }
        }
        // Tilde sequences: ESC [ N ~
        if (finalByte === 0x7e) {
          if (params === "5") { msgs.push(key(KeyPgUp)); continue; }
          if (params === "6") { msgs.push(key(KeyPgDn)); continue; }
        }
        continue; // skip unknown CSI
      }
      // Bare ESC
      msgs.push(key(KeyEscape));
      i++;
      continue;
    }

    // Control characters
    if (b === 0x03) {
      msgs.push(key("c", "", true));
      i++;
      continue;
    } // Ctrl+C
    if (b === 0x01) {
      msgs.push(key("a", "", true));
      i++;
      continue;
    } // Ctrl+A
    if (b === 0x0d || b === 0x0a) {
      msgs.push(key(KeyEnter));
      i++;
      continue;
    } // Enter
    if (b === 0x20) {
      msgs.push(key(KeySpace, " "));
      i++;
      continue;
    } // Space
    if (b === 0x7f || b === 0x08) {
      msgs.push(key(KeyBackspace));
      i++;
      continue;
    } // Backspace
    if (b === 0x09) {
      msgs.push(key("tab"));
      i++;
      continue;
    } // Tab
    // Skip other control chars
    if (b < 0x20) {
      i++;
      continue;
    }

    // UTF-8 decode
    let len = 1;
    if ((b & 0xe0) === 0xc0) len = 2;
    else if ((b & 0xf0) === 0xe0) len = 3;
    else if ((b & 0xf8) === 0xf0) len = 4;

    const slice = Buffer.from(bytes.slice(i, i + len));
    const char = slice.toString("utf8");
    i += len;
    msgs.push(key(char, char));
  }

  return msgs;
}

function key(code: string, text = "", ctrl = false): KeyPressMsg {
  return { type: "keypress", code, text, mod: { ctrl } };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export async function run(program: Program): Promise<void> {
  // Enter alt screen and hide cursor
  process.stdout.write("\x1b[?1049h\x1b[?25l");

  const isRaw = process.stdin.isTTY;
  if (isRaw) process.stdin.setRawMode(true);
  process.stdin.resume();

  let running = true;
  let quitResolve: (() => void) | null = null;
  let error: Error | null = null;

  function render() {
    // In raw mode, \n doesn't carriage-return — must use \r\n
    const output = program.view().replace(/\n/g, "\r\n");
    process.stdout.write("\x1b[H");
    process.stdout.write(output);
    process.stdout.write("\x1b[J"); // clear remaining content below
  }

  function dispatch(msg: Msg) {
    if (!running) return;
    if (msg.type === "quit") {
      running = false;
      quitResolve?.();
      return;
    }
    try {
      const cmds = program.update(msg);
      render();
      for (const cmd of cmds) {
        if (cmd) cmd().then(dispatch).catch((e) => {
            error = e as Error;
            running = false;
            quitResolve?.();
          });
      }
    } catch (e) {
      error = e as Error;
      running = false;
      quitResolve?.();
    }
  }

  // Send initial window size
  dispatch({
    type: "windowSize",
    width: process.stdout.columns || 80,
    height: process.stdout.rows || 24,
  } as WindowSizeMsg);

  // Run init commands
  const initCmds = program.init();
  for (const cmd of initCmds) {
    if (cmd) cmd().then(dispatch).catch((e) => {
      error = e as Error;
      running = false;
      quitResolve?.();
    });
  }

  render();

  // Keyboard input
  const onData = (data: Buffer) => {
    for (const msg of parseInput(data)) dispatch(msg);
  };
  process.stdin.on("data", onData);

  // Terminal resize
  const onResize = () => {
    dispatch({
      type: "windowSize",
      width: process.stdout.columns || 80,
      height: process.stdout.rows || 24,
    } as WindowSizeMsg);
  };
  process.stdout.on("resize", onResize);

  // Wait for quit
  await new Promise<void>((resolve) => {
    quitResolve = resolve;
  });

  // Cleanup
  process.stdin.off("data", onData);
  process.stdout.off("resize", onResize);
  if (isRaw) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\x1b[?25h\x1b[?1049l");

  if (error) throw error;
}
