import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { Panel, type PanelItem, type PanelHandle } from "./Panel.tsx";
import { BottomBar } from "./BottomBar.tsx";
import { DirInput } from "./DirInput.tsx";
import type { Colors } from "../config.ts";
import type { PickerData, PickerResult } from "./render.tsx";
import { mooxKill, listSessions, panesForTab } from "../moox.ts";

export interface AppProps {
  initialData: PickerData;
  onRefresh: () => Promise<PickerData>;
  colors: Colors;
  title: string;
  needsDir: (value: string) => { needs: boolean; initial: string } | null;
  onResult: (result: PickerResult) => void;
}

export function App({ initialData, onRefresh, colors, title, needsDir, onResult }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [termSize, setTermSize] = useState({
    width: stdout?.columns ?? 80,
    height: stdout?.rows ?? 24,
  });

  useEffect(() => {
    const onResize = () => {
      setTermSize({
        width: stdout?.columns ?? 80,
        height: stdout?.rows ?? 24,
      });
    };
    stdout?.on("resize", onResize);
    return () => { stdout?.off("resize", onResize); };
  }, [stdout]);

  const termWidth = termSize.width;
  const termHeight = termSize.height;

  const [data, setData] = useState<PickerData>(initialData);
  const hasRunning = data.runningItems.length > 0;
  const [activePanel, setActivePanel] = useState<"layouts" | "running">("layouts");

  // Overlay states
  const [dirPrompt, setDirPrompt] = useState<{ value: string; initial: string } | null>(null);
  const [namePrompt, setNamePrompt] = useState<{ prompt: string } | null>(null);
  const [killConfirm, setKillConfirm] = useState<{ ids: string[]; label: string } | null>(null);
  const popupJustClosed = useRef(false);

  const panelWidth = hasRunning ? Math.min(Math.floor(termWidth / 2), 50) : Math.min(termWidth, 50);
  const contentHeight = Math.max(5, termHeight - 3);

  const layoutsRef = useRef<PanelHandle>(null);
  const runningRef = useRef<PanelHandle>(null);

  const activeRef = activePanel === "layouts" ? layoutsRef : runningRef;

  const handleRefresh = useCallback(async () => {
    const newData = await onRefresh();
    setData(newData);
  }, [onRefresh]);

  const handleSelect = useCallback((value: string) => {
    const dirCheck = needsDir(value);
    if (dirCheck?.needs) {
      setDirPrompt({ value, initial: dirCheck.initial });
    } else {
      onResult({ choice: value });
      exit();
    }
  }, [needsDir, onResult, exit]);

  useInput((input, key) => {
    if ((key as any).eventType === "release") return;
    if (dirPrompt || namePrompt) return; // overlays handle their own input

    if (killConfirm) {
      if (input === "y" || input === "Y") {
        const ids = new Set(killConfirm.ids);
        const valueSet = new Set([...ids].map((id) => `existing-pane:${id}`));
        setKillConfirm(null);
        Promise.all([...ids].map((id) => mooxKill(id))).then(() => {
          let count = 0;
          const poll = setInterval(async () => {
            count++;
            const newData = await onRefresh();
            setData(newData);
            const stillAlive = newData.runningItems.some(
              (item) => valueSet.has(item.value),
            );
            if (!stillAlive || count >= 50) {
              clearInterval(poll);
            }
          }, 100);
        });
      } else {
        setKillConfirm(null);
      }
      return;
    }

    if (popupJustClosed.current) {
      popupJustClosed.current = false;
      return;
    }

    if (input === "q" || key.escape || (key.ctrl && (input === "c" || input === "d"))) {
      onResult({ choice: null });
      exit();
      return;
    }
    if (key.ctrl && input === "l") {
      handleRefresh();
      return;
    }
    if (key.tab || input === "h" || input === "l" || key.leftArrow || key.rightArrow) {
      if (hasRunning) {
        setActivePanel((p) => (p === "layouts" ? "running" : "layouts"));
      }
      return;
    }
    if (key.upArrow || input === "k") {
      activeRef.current?.moveUp();
      return;
    }
    if (key.downArrow || input === "j") {
      activeRef.current?.moveDown();
      return;
    }
    if (input === "G" || input === "$") {
      activeRef.current?.moveBottom();
      return;
    }
    if (input === "g" || input === "0") {
      activeRef.current?.moveTop();
      return;
    }
    if (input === "K") {
      const value = activeRef.current?.select();
      if (value?.startsWith("existing-pane:")) {
        const id = value.slice("existing-pane:".length);
        setKillConfirm({ ids: [id], label: id.slice(0, 8) });
      } else if (value?.startsWith("existing-tab:")) {
        const tabName = value.slice("existing-tab:".length);
        listSessions().then((sessions) => {
          const panes = panesForTab(sessions, tabName);
          if (panes.length > 0) {
            setKillConfirm({ ids: panes.map((p) => p.id), label: `tab "${tabName}" (${panes.length} panes)` });
          }
        });
      }
      return;
    }
    if (key.return) {
      const value = activeRef.current?.select();
      if (value) handleSelect(value);
      return;
    }
  });

  const totalWidth = hasRunning ? panelWidth * 2 : panelWidth;

  return (
    <>
      <Box flexDirection="column" width={totalWidth}>
        <Box flexDirection="row">
          <Panel
            ref={layoutsRef}
            title={data.leftTitle ?? "Layouts"}
            items={data.layoutItems}
            width={panelWidth}
            height={contentHeight}
            colors={colors}
            focused={!dirPrompt && !namePrompt && activePanel === "layouts"}
          />
          {hasRunning && (
            <Panel
              ref={runningRef}
              title="Running"
              items={data.runningItems}
              width={panelWidth}
              height={contentHeight}
              colors={colors}
              focused={!dirPrompt && !namePrompt && activePanel === "running"}
            />
          )}
        </Box>
        <BottomBar width={totalWidth} colors={colors} />
      </Box>
      {dirPrompt && (
        <Box
          position="absolute"
          width={termWidth}
          marginTop={Math.max(0, Math.floor((termHeight - 4) / 2))}
        >
          <Box marginLeft={Math.max(0, Math.floor((termWidth - 50) / 2))}>
            <DirInput
              prompt="Select start directory"
              initialValue={dirPrompt.initial}
              onSubmit={(dir) => {
                onResult({ choice: dirPrompt.value, dir });
                exit();
              }}
              onCancel={() => {
                popupJustClosed.current = true;
                setDirPrompt(null);
              }}
            />
          </Box>
        </Box>
      )}
      {namePrompt && (
        <Box
          position="absolute"
          width={termWidth}
          marginTop={Math.max(0, Math.floor((termHeight - 4) / 2))}
        >
          <Box marginLeft={Math.max(0, Math.floor((termWidth - 50) / 2))}>
            <DirInput
              prompt={namePrompt.prompt}
              initialValue=""
              onSubmit={(name) => {
                onResult({ choice: "new:", name });
                exit();
              }}
              onCancel={() => {
                popupJustClosed.current = true;
                setNamePrompt(null);
              }}
            />
          </Box>
        </Box>
      )}
      {killConfirm && (() => {
        const msg = ` Kill ${killConfirm.label}? (y/n) `;
        const w = msg.length + 2;
        return (
          <Box
            position="absolute"
            width={termWidth}
            marginTop={Math.max(0, Math.floor((termHeight - 2) / 2))}
          >
            <Box marginLeft={Math.max(0, Math.floor((termWidth - w) / 2))}>
              <Box flexDirection="column" width={w}>
                <Text color="cyan">{"\u256d" + "\u2500".repeat(w - 2) + "\u256e"}</Text>
                <Text>
                  <Text color="cyan">{"\u2502"}</Text>
                  <Text color="red" bold>{msg}</Text>
                  <Text color="cyan">{"\u2502"}</Text>
                </Text>
                <Text color="cyan">{"\u2570" + "\u2500".repeat(w - 2) + "\u256f"}</Text>
              </Box>
            </Box>
          </Box>
        );
      })()}
    </>
  );
}
