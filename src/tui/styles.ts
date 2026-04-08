// styles.ts — Terminal styling via chalk, mirroring the lipgloss styles from the Go version.

import chalk, { type ChalkInstance } from "chalk";

// List items
export const selectedStyle: ChalkInstance = chalk.bold.ansi256(212);
export const normalStyle: ChalkInstance = chalk.ansi256(252);

// Client indicators
export const activeClientStyle: ChalkInstance = chalk.ansi256(76); // green
export const inactiveClientStyle: ChalkInstance = chalk.ansi256(240); // dim

// Dir path
export const dirStyle: ChalkInstance = chalk.italic.ansi256(245);

// Pane titles
export const titleStyle: ChalkInstance = chalk.bold.ansi256(99);

// Help bar
export const helpStyle: ChalkInstance = chalk.ansi256(241);
export const helpKeyStyle: ChalkInstance = chalk.bold.ansi256(252);

// Status messages
export const statusStyle: ChalkInstance = chalk.ansi256(76);

// Confirm prompt
export const confirmStyle: ChalkInstance = chalk.bold.ansi256(196);

// Log pane
export const logDimStyle: ChalkInstance = chalk.ansi256(241);

// List column styles
export const pidStyle: ChalkInstance = chalk.ansi256(245); // neutral gray
export const memStyle: ChalkInstance = chalk.ansi256(180); // warm tan/gold
export const uptimeStyle: ChalkInstance = chalk.ansi256(109); // muted blue

// Filter match highlight
export const filterMatchStyle: ChalkInstance = chalk.bold.underline.ansi256(228);

// Sort indicator in pane title
export const sortStyle: ChalkInstance = chalk.bold.ansi256(75);

// Border characters
export const borderCharStyle: ChalkInstance = chalk.ansi256(240);
