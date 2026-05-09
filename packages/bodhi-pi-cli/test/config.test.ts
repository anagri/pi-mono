import { afterEach, describe, expect, it, vi } from "vitest";

// Must mock before importing config so process.env is read at call time.
describe("resolveConfig model resolution", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("picks the first model with an API key when no --model flag", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-test");
		const { resolveConfig } = await import("../src/config.js");
		const cfg = resolveConfig([]);
		expect(cfg.defaultModelId).toBeTruthy();
		// defaultModelId must appear in the full models list.
		expect(cfg.models.some((m) => m.id === cfg.defaultModelId)).toBe(true);
	});

	it("respects --model flag", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-test");
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		const { resolveConfig } = await import("../src/config.js");
		const cfg = resolveConfig([]);
		// Pick any available model id from the resolved config.
		const someId = cfg.models.find((m) => !!cfg.getApiKey(m.provider))!.id;
		const cfg2 = resolveConfig(["--model", someId]);
		expect(cfg2.defaultModelId).toBe(someId);
	});

	it("respects BODHI_MODEL env var", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-test");
		const { resolveConfig } = await import("../src/config.js");
		const cfg = resolveConfig([]);
		const someId = cfg.models.find((m) => !!cfg.getApiKey(m.provider))!.id;
		vi.stubEnv("BODHI_MODEL", someId);
		const cfg2 = resolveConfig([]);
		expect(cfg2.defaultModelId).toBe(someId);
	});

	it("uses defaultDbPath when --db is not provided", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-test");
		const { resolveConfig } = await import("../src/config.js");
		const cfg = resolveConfig([]);
		expect(cfg.dbPath).toContain("sessions.db");
	});

	it("uses --db when provided", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-test");
		const { resolveConfig } = await import("../src/config.js");
		const cfg = resolveConfig(["--db", "/tmp/custom.db"]);
		expect(cfg.dbPath).toBe("/tmp/custom.db");
	});

	it("loadExtensions defaults to true; --no-extensions disables it", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-test");
		const { resolveConfig } = await import("../src/config.js");
		expect(resolveConfig([]).loadExtensions).toBe(true);
		expect(resolveConfig(["--no-extensions"]).loadExtensions).toBe(false);
	});

	it("eventHandlers is undefined by default; set when --debug-events", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-test");
		const { resolveConfig } = await import("../src/config.js");
		expect(resolveConfig([]).eventHandlers).toBeUndefined();
		const cfg = resolveConfig(["--debug-events"]);
		expect(cfg.eventHandlers).toBeDefined();
		// All 19 lifecycle event types should be wired.
		expect(Object.keys(cfg.eventHandlers ?? {}).length).toBe(19);
	});

	it("BODHI_DEBUG_EVENTS=1 enables eventHandlers", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-test");
		vi.stubEnv("BODHI_DEBUG_EVENTS", "1");
		const { resolveConfig } = await import("../src/config.js");
		expect(resolveConfig([]).eventHandlers).toBeDefined();
	});
});
