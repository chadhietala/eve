#!/usr/bin/env node
/**
 * Fetches the Electron runtime the first time the desktop shell is launched.
 *
 * Electron's own postinstall is disabled for the workspace: it downloads
 * ~150 MB, and almost nobody working in this repository needs it. Paying that
 * cost here keeps `pnpm install` light for everyone else.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const electronRoot = dirname(require.resolve("electron/package.json"));

if (existsSync(join(electronRoot, "dist"))) process.exit(0);

console.log("Fetching the Electron runtime (first launch only)…");
const result = spawnSync(process.execPath, [join(electronRoot, "install.js")], {
  cwd: electronRoot,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
