import { afterEach, describe, expect, it, vi } from "vitest";

// Production cli reads zero env-var API keys after Phase J. These tests cover
// only the surface that survives: dbPath resolution, extension loading toggle,
// debug-events plumbing.
describe("resolveConfig", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("uses defaultDbPath when --db is not provided", async () => {
		const { resolveConfig } = await import("../src/config.js");
		const cfg = resolveConfig([]);
		expect(cfg.dbPath).toContain("sessions.db");
	});

	it("uses --db when provided", async () => {
		const { resolveConfig } = await import("../src/config.js");
		const cfg = resolveConfig(["--db", "/tmp/custom.db"]);
		expect(cfg.dbPath).toBe("/tmp/custom.db");
	});

	it("loadExtensions defaults to true; --no-extensions disables it", async () => {
		const { resolveConfig } = await import("../src/config.js");
		expect(resolveConfig([]).loadExtensions).toBe(true);
		expect(resolveConfig(["--no-extensions"]).loadExtensions).toBe(false);
	});

	it("eventHandlers is undefined by default; set when --debug-events", async () => {
		const { resolveConfig } = await import("../src/config.js");
		expect(resolveConfig([]).eventHandlers).toBeUndefined();
		const cfg = resolveConfig(["--debug-events"]);
		expect(cfg.eventHandlers).toBeDefined();
		expect(Object.keys(cfg.eventHandlers ?? {}).length).toBe(19);
	});
});
