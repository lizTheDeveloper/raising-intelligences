import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./server/tests",
  testMatch: "**/*.spec.ts",
  timeout: 30000,
  use: {
    baseURL: "http://localhost:5173",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
