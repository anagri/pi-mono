import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

loadEnv({ path: path.join(here, ".env.test") });

export default defineConfig({
	plugins: [tsconfigPaths()],
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
		exclude: ["node_modules", "dist"],
	},
});
