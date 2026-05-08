import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

const bodhiPiSrc = path.resolve(here, "../bodhi-pi/src/index.ts");
const aiSrc = path.resolve(here, "../ai/src/index.ts");
const agentSrc = path.resolve(here, "../agent/src/index.ts");

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@bodhiapp\/bodhi-pi$/, replacement: bodhiPiSrc },
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrc },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrc },
		],
	},
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
		exclude: ["node_modules", "dist"],
	},
});
