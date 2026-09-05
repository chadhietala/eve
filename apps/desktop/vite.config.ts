import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DEV_SERVER_ORIGIN = process.env.EVE_DESKTOP_SERVER ?? "http://127.0.0.1:7373";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "../../dist/renderer",
  },
  plugins: [react()],
  root: "src/renderer",
  server: {
    // In development the renderer runs on Vite and the control server runs
    // separately, so every API call is proxied to it.
    proxy: {
      "/api": DEV_SERVER_ORIGIN,
      "/computer": DEV_SERVER_ORIGIN,
    },
  },
});
