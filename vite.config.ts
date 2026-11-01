import { defineConfig } from "vite";
import { resolve } from "node:path";

const backendPort = process.env.PORT ?? "3000";
const backend = `http://127.0.0.1:${backendPort}`;

export default defineConfig({
  publicDir: "public",
  resolve: {
    alias: {
      "@shared": resolve(import.meta.dirname, "src/shared"),
      "@": resolve(import.meta.dirname, "src/client"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/ws": { target: backend.replace("http", "ws"), ws: true },
      "/api": { target: backend },
      "/healthz": { target: backend },
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 4096,
    sourcemap: false,
    chunkSizeWarningLimit: 1800,
    rollupOptions: {
      input: {
        arena: resolve(import.meta.dirname, "index.html"),
        aftermath: resolve(import.meta.dirname, "aftermath.html"),
      },
      output: {
        manualChunks: {
          phaser: ["phaser"],
          three: ["three"],
        },
      },
    },
  },
});
