import { describe, expect, test } from "vitest";
import { loadProjectSettings } from "@/core/settings.js";
import { createInMemoryFilesystem } from "@/index.js";
import { seedProjectSettings } from "./helpers/filesystem.js";

describe("loadProjectSettings", () => {
	test("missing file → empty result, present=false", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir("/proj", { recursive: true });
		const out = await loadProjectSettings(fs, "/proj");
		expect(out).toEqual({ settings: {}, present: false });
	});

	test("parses valid JSON", async () => {
		const fs = createInMemoryFilesystem();
		await seedProjectSettings(
			fs,
			"/proj",
			JSON.stringify({ compaction: { reserveTokens: 99999 }, appendSystemPrompt: "extra" }),
		);
		const out = await loadProjectSettings(fs, "/proj");
		expect(out.present).toBe(true);
		expect(out.settings.compaction).toEqual({ reserveTokens: 99999 });
		expect(out.settings.appendSystemPrompt).toBe("extra");
		expect(out.parseError).toBeUndefined();
	});

	test("malformed JSON → present=true, parseError set, empty settings", async () => {
		const fs = createInMemoryFilesystem();
		await seedProjectSettings(fs, "/proj", "{ not-json");
		const out = await loadProjectSettings(fs, "/proj");
		expect(out.present).toBe(true);
		expect(out.settings).toEqual({});
		expect(out.parseError).toMatch(/invalid JSON/);
	});

	test("JSON top-level not an object → parseError set", async () => {
		const fs = createInMemoryFilesystem();
		await seedProjectSettings(fs, "/proj", `["array"]`);
		const out = await loadProjectSettings(fs, "/proj");
		expect(out.present).toBe(true);
		expect(out.settings).toEqual({});
		expect(out.parseError).toMatch(/must be a JSON object/);
	});

	test("unknown keys preserved on returned settings", async () => {
		const fs = createInMemoryFilesystem();
		await seedProjectSettings(fs, "/proj", JSON.stringify({ futureFlag: 42 }));
		const out = await loadProjectSettings(fs, "/proj");
		expect(out.settings.futureFlag).toBe(42);
	});
});
