import { app, BrowserWindow, shell } from "electron";

import { startDesktopServer } from "../server/server.js";

/**
 * The Electron shell is deliberately thin: it starts the control server and
 * points a window at it. Everything the window can do, a phone on the same
 * pairing link can do too, because they are the same app served over the same
 * routes.
 */
async function main(): Promise<void> {
  await app.whenReady();
  const desktop = await startDesktopServer({ host: "127.0.0.1" });
  const url = desktop.pairingUrl("127.0.0.1");

  const window = new BrowserWindow({
    backgroundColor: "#0a0a0a",
    height: 820,
    minHeight: 560,
    minWidth: 880,
    show: false,
    title: "eve",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
    width: 1_280,
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    // Anything that is not this app opens in the user's browser, not in a
    // chromeless window with the pairing cookie attached.
    void shell.openExternal(target);
    return { action: "deny" };
  });
  await window.loadURL(url);

  app.on("window-all-closed", () => {
    void desktop.close().finally(() => app.quit());
  });
}

void main();
