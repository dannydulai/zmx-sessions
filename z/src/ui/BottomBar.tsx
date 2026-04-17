import React from "react";
import { Box, Text } from "ink";
import type { Colors } from "../config.ts";

interface BottomBarProps {
  width: number;
  colors: Colors;
}

const KEYS = [
  { key: "Tab", desc: "panel" },
  { key: "Enter", desc: "select" },
  { key: "^L", desc: "refresh" },
  { key: "q", desc: "quit" },
];

export function BottomBar({ width }: BottomBarProps) {
  return (
    <Box width={width}>
      <Text>
        {" "}
        <Text bold color="cyan">z</Text>
        <Text dimColor>{" \u2502 "}</Text>
        {KEYS.map((k, i) => (
          <React.Fragment key={k.key}>
            {i > 0 && <Text dimColor>{"  "}</Text>}
            <Text bold color="white">{k.key}</Text>
            <Text dimColor>{" " + k.desc}</Text>
          </React.Fragment>
        ))}
      </Text>
    </Box>
  );
}
