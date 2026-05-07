import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// e2e-only env layer (real API keys). Base config already loads .env and
// test/.env.test; we additionally apply e2e/.env.test with override.
loadEnv({ path: path.join(here, "e2e", ".env.test"), override: true });

// We import baseConfig only to inherit `resolve.alias`. We do NOT use
// vitest's mergeConfig because it concatenates arrays — including
// `test.include` — which would cause e2e runs to also pick up
// `src/**/*.test.ts` and `test/**/*.test.ts`. Compose explicitly instead.
const base = typeof baseConfig === "function" ? baseConfig({ command: "serve", mode: "test" }) : baseConfig;

export default defineConfig({
	resolve: base.resolve,
	test: {
		globals: true,
		environment: "node",
		testTimeout: 60000,
		include: ["e2e/**/*.e2e.ts"],
	},
});
