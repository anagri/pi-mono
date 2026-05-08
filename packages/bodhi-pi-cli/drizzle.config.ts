import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/sessions/schema.ts",
	out: "./drizzle",
	dialect: "sqlite",
});
