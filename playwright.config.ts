import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "ui.spec.mjs",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4328", headless: true },
  webServer: {
    command: `npm run build && MR_ON_DATA=.data/ui-test-${process.pid} PORT=4328 npm start`,
    url: "http://127.0.0.1:4328",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
