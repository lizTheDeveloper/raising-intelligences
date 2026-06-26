import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: process.env.NODE_ENV === "production" ? "/raising-intelligences/" : "/",
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        timeout: 180000,
        proxyTimeout: 180000,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
              // Flush headers immediately so the browser opens the SSE connection
              // instead of waiting for the proxy to buffer the full response.
              res.flushHeaders();
            }
          });
        },
      },
      // Generated portraits live on the Express server, not in client/public.
      // Only needed for dev — in production the Express server handles /portraits directly.
      "/portraits": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
