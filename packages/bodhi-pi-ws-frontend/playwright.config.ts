import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { config as loadEnv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
// Load OPENAI_API_KEY etc. from the ws-server's .env so test.skip(!OPENAI_API_KEY) sees it.
loadEnv({ path: path.resolve(here, "../bodhi-pi-ws-server/.env") });

const FRONTEND_PORT = 35273;
const WS_SERVER_PORT = 8788;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm --workspace=@bodhiapp/bodhi-pi-ws-server run dev",
      cwd: "../..",
      env: { PORT: String(WS_SERVER_PORT) },
      url: `http://localhost:${WS_SERVER_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `npx --no-install vite --port ${FRONTEND_PORT} --strictPort`,
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
