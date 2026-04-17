import React from "react";
import { render } from "ink";
import { App } from "./App.tsx";
import type { PanelItem } from "./Panel.tsx";
import type { Colors } from "../config.ts";

export type { PanelItem };

export const REFRESH = "__refresh__";

export interface PickerData {
  layoutItems: PanelItem[];
  runningItems: PanelItem[];
  leftTitle?: string;
}

export interface PickerResult {
  choice: string | null;
  dir?: string;
  name?: string;
}

export type NeedsDirFn = (value: string) => { needs: boolean; initial: string } | null;

export async function showPicker(
  initialData: PickerData,
  onRefresh: () => Promise<PickerData>,
  colors: Colors,
  title: string,
  needsDir: NeedsDirFn,
): Promise<PickerResult> {
  let result: PickerResult = { choice: null };

  const { waitUntilExit } = render(
    <App
      initialData={initialData}
      onRefresh={onRefresh}
      colors={colors}
      title={title}
      needsDir={needsDir}
      onResult={(r) => {
        result = r;
      }}
    />,
    { exitOnCtrlC: false, alternateScreen: true },
  );

  await waitUntilExit();

  // Ensure stdin is fully reset after Ink — it can leave listeners or raw mode
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.removeAllListeners("data");
  process.stdin.pause();

  if (result.choice === "exit") return { choice: null };
  return result;
}
