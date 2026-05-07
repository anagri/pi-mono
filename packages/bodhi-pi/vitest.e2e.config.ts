import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

loadEnv({ path: path.join(here, ".env") });
loadEnv({ path: path.join(here, "e2e", ".env.test"), override: true });

const aiSrc = path.resolve(here, "../ai/src/index.ts");
const agentSrc = path.resolve(here, "../agent/src/index.ts");

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrc },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrc },
		],
	},
	test: {
		globals: true,
		environment: "node",
		testTimeout: 60000,
		include: ["e2e/**/*.e2e.ts"],
	},
});
