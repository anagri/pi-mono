import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

// Load runtime env first (if present), then test-specific overrides.
loadEnv({ path: path.join(here, ".env") });
loadEnv({ path: path.join(here, "test", ".env.test"), override: true });

const aiSrc = path.resolve(here, "../ai/src/index.ts");
const agentSrc = path.resolve(here, "../agent/src/index.ts");

export default defineConfig({
	plugins: [tsconfigPaths()],
	resolve: {
		alias: [
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrc },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrc },
		],
	},
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
		exclude: ["node_modules", "dist", "e2e/**"],
	},
});
