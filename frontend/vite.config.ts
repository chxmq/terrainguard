import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";
import path from "path";

// SPA dev server proxies the API to the FastAPI backend on :8000, so the React
// app and the Python service run side by side with no CORS friction.
export default defineConfig({
  plugins: [react(), cesium()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Cesium KML paths use a subpath that newer @zip.js/zip.js no longer exports.
      "@zip.js/zip.js/lib/zip-no-worker.js": path.resolve(
        __dirname,
        "node_modules/@zip.js/zip.js/lib/zip-no-worker.js",
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
  },
  build: { outDir: "dist", chunkSizeWarningLimit: 4000 },
});
