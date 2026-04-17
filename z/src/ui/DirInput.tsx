import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { readdirSync, statSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";

interface DirInputProps {
  prompt: string;
  initialValue: string;
  onSubmit: (dir: string) => void;
  onCancel: () => void;
}

function compactPath(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

function expandPath(p: string): string {
  const home = homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

function isExistingDir(p: string): boolean {
  try {
    return statSync(expandPath(p)).isDirectory();
  } catch {
    return false;
  }
}

function listSubdirs(pathStr: string): string[] {
  try {
    const abs = expandPath(pathStr);
    const entries = readdirSync(abs, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function bell() {
  process.stdout.write("\x07");
}

// Fuzzy match: all chars of query appear in s in order (not necessarily contiguous)
function fuzzyMatch(s: string, query: string): boolean {
  if (!query) return true;
  let i = 0;
  for (const ch of s) {
    if (ch === query[i]) {
      i++;
      if (i === query.length) return true;
    }
  }
  return false;
}

export function DirInput({ prompt, initialValue, onSubmit, onCancel }: DirInputProps) {
  const { exit } = useApp();

  // Normalize initial value: absolute path, trailing slash
  const initialPath = (() => {
    let p = initialValue;
    if (!p) p = process.cwd();
    const expanded = expandPath(p);
    const normalized = existsSync(expanded) && statSync(expanded).isDirectory()
      ? expanded
      : process.cwd();
    const compact = compactPath(resolve(normalized));
    return compact.endsWith("/") ? compact : compact + "/";
  })();

  const [path, setPath] = useState<string>(initialPath);
  const [selIdx, setSelIdx] = useState<number>(-1); // -1 = no selection

  // If path ends with "/", list all subdirs of that path.
  // Otherwise, list subdirs of the parent path, fuzzy-filtered by the trailing segment.
  const subdirs = (() => {
    if (path.endsWith("/")) return listSubdirs(path);
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash < 0) return [];
    const parent = path.slice(0, lastSlash + 1);
    const query = path.slice(lastSlash + 1).toLowerCase();
    return listSubdirs(parent).filter((n) => fuzzyMatch(n.toLowerCase(), query));
  })();

  // Reset selection when path changes
  useEffect(() => {
    setSelIdx(-1);
  }, [path]);

  useInput((input, key) => {
    if ((key as any).eventType === "release") return;

    if (key.escape) {
      onCancel();
      exit();
      return;
    }

    if (key.return) {
      if (selIdx >= 0 && selIdx < subdirs.length) {
        // Pick the highlighted subdir — replace partial trailing segment with full name
        const picked = subdirs[selIdx];
        const lastSlash = path.lastIndexOf("/");
        const parent = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
        setPath(parent + picked + "/");
        return;
      }
      // Submit the current path if it exists
      const target = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
      if (isExistingDir(target)) {
        onSubmit(expandPath(target));
        exit();
      } else {
        bell();
      }
      return;
    }

    if (key.downArrow || key.tab) {
      if (subdirs.length === 0) return;
      setSelIdx((i) => Math.min(subdirs.length - 1, i + 1));
      return;
    }
    if (key.upArrow || (key.shift && key.tab)) {
      setSelIdx((i) => Math.max(-1, i - 1));
      return;
    }

    if (key.ctrl && (input === "u" || input === "w")) {
      // Delete back to previous slash
      setPath((p) => {
        let s = p.endsWith("/") ? p.slice(0, -1) : p;
        const slash = s.lastIndexOf("/");
        return slash >= 0 ? s.slice(0, slash + 1) : "";
      });
      return;
    }

    if (key.backspace || key.delete) {
      setPath((p) => p.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setPath((p) => p + input);
    }
  });

  const width = 50;
  const innerWidth = width - 2;
  const titleStr = ` ${prompt} `;
  const topFill = Math.max(0, innerWidth - titleStr.length - 1);
  const topBorder = "\u256d\u2500" + titleStr + "\u2500".repeat(topFill) + "\u256e";
  const midBorder = "\u251c" + "\u2500".repeat(innerWidth) + "\u2524";
  const bottomBorder = "\u2570" + "\u2500".repeat(innerWidth) + "\u256f";

  // Display path (truncated from left if too long)
  const pathDisplay = path.length > innerWidth - 3
    ? "\u2026" + path.slice(path.length - innerWidth + 4)
    : path;
  const inputPad = Math.max(0, innerWidth - pathDisplay.length - 2);

  const maxEntries = 10;
  const visible = subdirs.slice(0, maxEntries);

  return (
    <Box flexDirection="column" width={width}>
      <Text color="cyan">{topBorder}</Text>
      <Text>
        <Text color="cyan">{"\u2502"}</Text>
        <Text> </Text>
        <Text bold>{pathDisplay}</Text>
        <Text dimColor>{"\u2588"}</Text>
        <Text>{" ".repeat(inputPad)}</Text>
        <Text color="cyan">{"\u2502"}</Text>
      </Text>
      <Text color="cyan">{midBorder}</Text>
      {visible.length === 0 && (
        <Text>
          <Text color="cyan">{"\u2502"}</Text>
          <Text dimColor> (no subdirs)</Text>
          <Text>{" ".repeat(innerWidth - 13)}</Text>
          <Text color="cyan">{"\u2502"}</Text>
        </Text>
      )}
      {visible.map((name, i) => {
        const isSel = i === selIdx;
        const display = name + "/";
        const truncated = display.length > innerWidth - 2
          ? display.slice(0, innerWidth - 5) + "..."
          : display;
        const pad = Math.max(0, innerWidth - truncated.length - 2);
        return (
          <Text key={name}>
            <Text color="cyan">{"\u2502"}</Text>
            {isSel ? (
              <Text backgroundColor="blue" color="white">
                {" " + truncated + " ".repeat(pad + 1)}
              </Text>
            ) : (
              <Text>
                {" " + truncated + " ".repeat(pad + 1)}
              </Text>
            )}
            <Text color="cyan">{"\u2502"}</Text>
          </Text>
        );
      })}
      <Text color="cyan">{bottomBorder}</Text>
    </Box>
  );
}
