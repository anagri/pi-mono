import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

loadEnv({ path: path.join(here, ".env") });
loadEnv({ path: path.join(here, ".env.test") });

// Fail-fast: real-LLM e2e requires API keys. A missing key is a setup error,
// not a test the runner should silently elide. Mirrors the policy in
// `packages/bodhi-pi/e2e` and `packages/bodhi-pi-ws-frontend/e2e/global-setup.ts`.
const required = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
	throw new Error(
		`Missing required env vars for bodhi-pi-http e2e: ${missing.join(", ")}. ` +
			`Set them in packages/bodhi-pi-http/.env or .env.test.`,
	);
}

const bodhiPiSrc = path.resolve(here, "../bodhi-pi/src/index.ts");
const bodhiPiNodeSrc = path.resolve(here, "../bodhi-pi-node/src/index.ts");
const aiSrc = path.resolve(here, "../ai/src/index.ts");
const agentSrc = path.resolve(here, "../agent/src/index.ts");

export default defineConfig({
	plugins: [tsconfigPaths()],
	resolve: {
		alias: [
			{ find: /^@bodhiapp\/bodhi-pi$/, replacement: bodhiPiSrc },
			{ find: /^@bodhiapp\/bodhi-pi-node$/, replacement: bodhiPiNodeSrc },
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrc },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrc },
		],
	},
	test: {
		globals: true,
		environment: "node",
		testTimeout: 60000,
		include: ["e2e/**/*.e2e.ts"],
		exclude: ["node_modules", "dist", "src/frontend"],
	},
});
