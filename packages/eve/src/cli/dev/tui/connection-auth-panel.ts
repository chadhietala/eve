import type { Theme } from "./theme.js";
import { stripTerminalControls, wrapVisibleLine } from "./terminal-text.js";

export interface ConnectionAuthPanelState {
  name: string;
  url?: string;
  userCode?: string;
  expiresAt?: string;
  instructions?: string;
  cancelFocused: boolean;
  frame: string;
  now: number;
}

function remainingSeconds(expiresAt: string | undefined, now: number): number | undefined {
  if (expiresAt === undefined) return undefined;
  const expiration = Date.parse(expiresAt);
  if (!Number.isFinite(expiration)) return undefined;
  return Math.max(0, Math.ceil((expiration - now) / 1_000));
}

function indentedRows(
  text: string,
  indent: string,
  width: number,
  style: (line: string) => string,
): string[] {
  return wrapVisibleLine(stripTerminalControls(text), Math.max(1, width - indent.length)).map(
    (line) => `${indent}${style(line)}`,
  );
}

export function renderConnectionAuthPanel(
  state: ConnectionAuthPanelState,
  theme: Theme,
  width: number,
): string[] {
  const c = theme.colors;
  const name = stripTerminalControls(state.name);
  const remaining = remainingSeconds(state.expiresAt, state.now);
  const countdown = remaining === undefined ? "" : ` ${remaining}s`;
  const rows = [
    c.dim(theme.glyph.hrule.repeat(Math.max(1, width))),
    `   Authorization required for ${c.bold(name)}`,
    "",
    `   ${c.yellow(state.frame)} ${c.dim(`Waiting for connection authorization${theme.glyph.ellipsis}${countdown}`)}`,
  ];

  if (state.url !== undefined) {
    rows.push(...indentedRows(state.url, "     ", width, c.dim));
  }
  if (state.userCode !== undefined) {
    rows.push("", `     Code: ${c.bold(stripTerminalControls(state.userCode))}`);
  }
  if (state.instructions !== undefined) {
    rows.push("", ...indentedRows(state.instructions, "     ", width, c.dim));
  }

  const marker = state.cancelFocused ? c.cyan(theme.glyph.pointer) : c.dim(theme.glyph.option);
  const label = state.cancelFocused ? c.cyan("Cancel") : "Cancel";
  rows.push("", `   ${marker} ${label}`);
  return rows;
}
