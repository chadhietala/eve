/** Entry point for `pnpm dev`: the control server alone, no renderer. */
import { startDesktopServer } from "./server.js";

const desktop = await startDesktopServer({ host: "127.0.0.1", port: 7373 });
console.log(`eve desktop control server on http://127.0.0.1:${desktop.port}`);
console.log(`Renderer: http://localhost:5173/?t=${desktop.config.controlToken}`);
