import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// SPA dev server proxies the API to the FastAPI backend on :8000, so the React
// app and the Python service run side by side with no CORS friction.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
  },
  build: { outDir: "dist", chunkSizeWarningLimit: 4000 },
});
