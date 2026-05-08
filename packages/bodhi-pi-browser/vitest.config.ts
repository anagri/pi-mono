import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
		exclude: ["node_modules", "dist"],
	},
});
