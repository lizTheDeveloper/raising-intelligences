import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: process.env.NODE_ENV === "production" ? "/raising-intelligences/" : "/",
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
