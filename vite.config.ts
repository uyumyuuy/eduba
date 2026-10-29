import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Project data and exported HTML can be locked by other apps on Windows.
    // They are not application sources and must not stop the dev server.
    watch: { ignored: ["**/src-tauri/**", "**/data/**", "**/tmp/**"] },
  },
  build: { target: "es2022" },
  test: { environment: "jsdom", globals: true },
});
