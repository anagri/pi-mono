import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// e2e-only: load real API keys from e2e/.env.test (already loaded for unit tests
// from test/.env.test by the base config; we re-apply with override to add e2e
// values without depending on file order).
loadEnv({ path: path.join(here, "e2e", ".env.test"), override: true });

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			testTimeout: 60000,
			include: ["e2e/**/*.e2e.ts"],
		},
	}),
);
