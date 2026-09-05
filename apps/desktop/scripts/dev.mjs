#!/usr/bin/env node
/**
 * Development: the control server on 7373 and the Vite renderer beside it.
 *
 * The renderer proxies `/api` and `/computer` to the server, so the browser
 * sees the same origin it will see in the packaged app.
 */
import { spawn } from "node:child_process";

const children = [
  spawn("node", ["--experimental-strip-types", "./src/server/dev-server.ts"], {
    stdio: "inherit",
  }),
  spawn("vite", [], { shell: true, stdio: "inherit" }),
];

for (const child of children) {
  child.on("exit", (code) => {
    for (const other of children) if (other !== child) other.kill();
    process.exit(code ?? 0);
  });
}

process.on("SIGINT", () => {
  for (const child of children) child.kill();
});
