import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";

export default defineConfig({
  plugins: [
    react(),
    // GlitchTip sourcemap upload. Only activates when SENTRY_AUTH_TOKEN is set
    // (production deploy) so local dev and tokenless CI builds still succeed
    // with no upload attempt and no network call. Must be the LAST plugin so
    // it sees the final bundle. filesToDeleteAfterUpload removes the .map
    // files once uploaded so they never ship in the built image.
    ...(process.env.SENTRY_AUTH_TOKEN
      ? [
          sentryVitePlugin({
            org: "multiverse-studios",
            project: "raising-intelligences",
            url: "https://errors.multiversegames.ai",
            authToken: process.env.SENTRY_AUTH_TOKEN,
            release: { name: process.env.VITE_SENTRY_RELEASE },
            sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
          }),
        ]
      : []),
  ],
  base: process.env.NODE_ENV === "production" ? "/raising-intelligences/" : "/",
  build: {
    // Emit .map files with no sourceMappingURL comment, so maps are uploaded
    // to GlitchTip for symbolication but never referenced or served to the
    // browser (and are deleted post-upload by the plugin above).
    sourcemap: "hidden",
  },
  server: {
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.PORT ?? 3000}`,
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
      // The multiplayer socket. In production Traefik has a dedicated router
      // for /raising-intelligences/socket.io; in dev the client asks for
      // plain /socket.io on the vite origin, so without this every socket
      // connection fails against vite itself and nothing multiplayer works
      // locally at all — create, join and the invite-link e2e spec included.
      // `ws: true` because socket.io upgrades off HTTP.
      "/socket.io": {
        target: `http://localhost:${process.env.PORT ?? 3000}`,
        ws: true,
        changeOrigin: true,
      },
      // Generated portraits live on the Express server, not in client/public.
      // Only needed for dev — in production the Express server handles /portraits directly.
      "/portraits": {
        target: `http://localhost:${process.env.PORT ?? 3000}`,
        changeOrigin: true,
      },
    },
  },
});
