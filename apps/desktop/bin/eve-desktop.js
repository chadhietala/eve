#!/usr/bin/env node
import { networkInterfaces } from "node:os";

import { startDesktopServer } from "../dist/server/server.js";

const args = process.argv.slice(2);
const host = readOption("--host") ?? "127.0.0.1";
const port = Number(readOption("--port") ?? 7373);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("eve-desktop: --port must be a port number.");
  process.exit(1);
}

const desktop = await startDesktopServer({ host, port });
const url = desktop.pairingUrl(host === "0.0.0.0" ? localAddress() : host);

console.log(`eve desktop is serving on http://${host}:${desktop.port}`);
console.log(`Open this on another device to pair it:\n  ${url}`);
if (host === "0.0.0.0") {
  console.log(
    "\nThis interface is reachable from your network. Anyone with the link above can see and\ncontrol this screen, so share it only with a device you trust.",
  );
}

process.on("SIGINT", () => void desktop.close().then(() => process.exit(0)));

function readOption(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function localAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}
