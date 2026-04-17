import React, { useState, useEffect, useImperativeHandle, forwardRef } from "react";
import { Box, Text } from "ink";
import type { Colors, Style } from "../config.ts";

export interface PanelItem {
  label: string;
  value: string;
  selectable?: boolean;
  indent?: number;
  type?: "tab" | "pane" | "new" | "exit" | "header";
  suffix?: string; // displayed dimmed after the label
  id?: string;     // displayed in grey brackets after the label
}

export interface PanelHandle {
  moveUp: () => void;
  moveDown: () => void;
  moveTop: () => void;
  moveBottom: () => void;
  select: () => string | null;
}

interface PanelProps {
  title: string;
  items: PanelItem[];
  width: number;
  height: number;
  colors: Colors;
  focused: boolean;
}

function selectableIndices(items: PanelItem[]): number[] {
  return items
    .map((item, i) => (item.selectable !== false ? i : -1))
    .filter((i) => i >= 0);
}

function styleForType(type: PanelItem["type"], colors: Colors): Style {
  switch (type) {
    case "tab": return colors.tab;
    case "pane": return colors.pane;
    case "new": return colors.new;
    case "header": return { dim: true };
    default: return { dim: true };
  }
}

export const Panel = forwardRef<PanelHandle, PanelProps>(
  function Panel({ title, items, width, height, colors, focused }, ref) {
    const selectable = selectableIndices(items);
    const [cursorIdx, setCursorIdx] = useState(0);
    const [scrollOffset, setScrollOffset] = useState(0);

    useEffect(() => {
      if (cursorIdx >= selectable.length) {
        setCursorIdx(Math.max(0, selectable.length - 1));
      }
    }, [selectable.length]);

    useEffect(() => {
      if (selectable.length === 0) return;
      const itemIdx = selectable[cursorIdx];
      if (itemIdx < scrollOffset) {
        setScrollOffset(itemIdx);
      } else if (itemIdx >= scrollOffset + height) {
        setScrollOffset(itemIdx - height + 1);
      }
    }, [cursorIdx, height]);

    useImperativeHandle(ref, () => ({
      moveUp() {
        setCursorIdx((c) => Math.max(0, c - 1));
      },
      moveDown() {
        setCursorIdx((c) => Math.min(selectable.length - 1, c + 1));
      },
      moveTop() {
        setCursorIdx(0);
      },
      moveBottom() {
        setCursorIdx(Math.max(0, selectable.length - 1));
      },
      select(): string | null {
        if (selectable.length === 0) return null;
        return items[selectable[cursorIdx]]?.value ?? null;
      },
    }));

    const innerWidth = width - 2;
    const borderColor = focused ? "cyan" : "gray";

    const titleStr = ` ${title} `;
    const topFill = Math.max(0, innerWidth - titleStr.length - 1);
    const topBorder = "\u256d\u2500" + titleStr + "\u2500".repeat(topFill) + "\u256e";
    const bottomBorder = "\u2570" + "\u2500".repeat(innerWidth) + "\u256f";

    return (
      <Box flexDirection="column" width={width}>
        <Text color={borderColor}>{topBorder}</Text>
        {Array.from({ length: height }, (_, viewIdx) => {
          const itemIdx = scrollOffset + viewIdx;
          const item = itemIdx < items.length ? items[itemIdx] : null;

          if (!item) {
            return (
              <Text key={viewIdx}>
                <Text color={borderColor}>{"\u2502"}</Text>
                <Text>{" ".repeat(innerWidth)}</Text>
                <Text color={borderColor}>{"\u2502"}</Text>
              </Text>
            );
          }

          const isSelected = focused && selectable[cursorIdx] === itemIdx;
          const indent = "  ".repeat(item.indent ?? 0);
          const style = styleForType(item.type, colors);
          const sel = colors.selection;

          let labelText = `  ${indent}${item.label}`;
          let idText = item.id ? ` [${item.id}]` : "";
          let suffixText = item.suffix ? `  ${item.suffix}` : "";
          let labelLen = stripAnsi(labelText).length;
          let idLen = idText.length;
          let suffixLen = stripAnsi(suffixText).length;
          let fullLen = labelLen + idLen + suffixLen;

          // Truncate if overflowing: drop suffix first, then id, then truncate label
          if (fullLen > innerWidth) {
            suffixText = "";
            suffixLen = 0;
            fullLen = labelLen + idLen;
          }
          if (fullLen > innerWidth) {
            idText = "";
            idLen = 0;
            fullLen = labelLen;
          }
          if (fullLen > innerWidth) {
            labelText = labelText.slice(0, Math.max(0, innerWidth - 1)) + "\u2026";
            labelLen = innerWidth;
            fullLen = innerWidth;
          }
          const pad = Math.max(0, innerWidth - fullLen);

          if (isSelected) {
            return (
              <Text key={viewIdx}>
                <Text color={borderColor}>{"\u2502"}</Text>
                <Text
                  color={sel.fg}
                  backgroundColor={sel.bg}
                  bold={sel.bold}
                  dimColor={sel.dim}
                  italic={sel.italic}
                >
                  {labelText}
                </Text>
                {idText && (
                  <Text backgroundColor={sel.bg} color="gray">
                    {idText}
                  </Text>
                )}
                {suffixText && (
                  <Text backgroundColor={sel.bg} dimColor>
                    {suffixText}
                  </Text>
                )}
                <Text backgroundColor={sel.bg}>{" ".repeat(pad)}</Text>
                <Text color={borderColor}>{"\u2502"}</Text>
              </Text>
            );
          }

          return (
            <Text key={viewIdx}>
              <Text color={borderColor}>{"\u2502"}</Text>
              <Text
                color={style.fg}
                bold={style.bold}
                dimColor={style.dim}
                italic={style.italic}
              >
                {labelText}
              </Text>
              {idText && <Text color="gray">{idText}</Text>}
              {suffixText && <Text dimColor>{suffixText}</Text>}
              <Text>{" ".repeat(pad)}</Text>
              <Text color={borderColor}>{"\u2502"}</Text>
            </Text>
          );
        })}
        <Text color={borderColor}>{bottomBorder}</Text>
      </Box>
    );
  }
);

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
