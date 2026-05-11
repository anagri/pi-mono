import fs from "node:fs/promises";
import path from "node:path";
import { createNodeExtensionLoader } from "@bodhiapp/bodhi-pi-node";
import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { loadFixture } from "@test/helpers/seed-workspace.js";
import { afterEach, expect, test } from "vitest";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;

async function seedExtensions(tmpDir: string, files: Record<string, string>): Promise<void> {
	const dir = path.join(tmpDir, ".bodhi-pi", "extensions");
	await fs.mkdir(dir, { recursive: true });
	for (const [name, body] of Object.entries(files)) {
		await fs.writeFile(path.join(dir, name), body, "utf8");
	}
}

afterEach(async () => {
	await harness?.cleanup();
});

test("CLI host loads extensions via Node loader and applies redact-secrets to a real LLM tool turn", async () => {
	const tmpDir = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "bodhi-pi-cli-ext-"));
	try {
		await seedExtensions(tmpDir, {
			"redact-secrets.js": await loadFixture("extensions-redact-secrets/.bodhi-pi/extensions/redact-secrets.js"),
		});

		// Write a leak file under tmpDir for the LLM to read.
		await fs.writeFile(
			path.join(tmpDir, "leak.txt"),
			"the API_KEY is sk-PLAINTEXTSECRETXYZ123 — keep secret",
			"utf8",
		);

		const factories = await createNodeExtensionLoader({ cwd: tmpDir });
		expect(factories.map((f) => f.name)).toContain("redact-secrets");

		// Manually build harness with the loaded factories. cli-harness doesn't expose
		// extensionFactories in its current shape, so we use createCliTestHarness's
		// new option — see test/helpers/cli-harness.ts.
		harness = await createCliTestHarness({
			model: getModel("openai", "gpt-4o-mini"),
			apiKey: OPENAI_KEY,
			extensionFactories: factories,
		});

		// Use harness.tmpDir as cwd so the file we want is at <tmpDir>/leak.txt;
		// rewrite the file there.
		await fs.writeFile(
			path.join(harness.tmpDir, "leak.txt"),
			"the API_KEY is sk-PLAINTEXTSECRETXYZ123 — keep secret",
			"utf8",
		);

		await harness.clientConn.initialize(stdInitParams);
		const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });
		await harness.clientConn.prompt({
			sessionId,
			prompt: [
				{
					type: "text",
					text: "Read the file leak.txt and tell me what's there verbatim.",
				},
			],
		});

		const completed = harness.updates.find(
			(u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
		);
		const flat = JSON.stringify(completed);
		expect(flat).toContain("[REDACTED]");
		expect(flat).not.toContain("sk-PLAINTEXTSECRETXYZ123");
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test("CLI host loads dynamic-tools extension via Node loader; LLM picks up bodhi_echo", async () => {
	const tmpDir = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "bodhi-pi-cli-ext-"));
	try {
		await seedExtensions(tmpDir, {
			"dynamic-tools.js": await loadFixture("extensions-dynamic-tools/.bodhi-pi/extensions/dynamic-tools.js"),
		});

		const factories = await createNodeExtensionLoader({ cwd: tmpDir });
		expect(factories.map((f) => f.name)).toContain("dynamic-tools");

		harness = await createCliTestHarness({
			model: getModel("openai", "gpt-4o-mini"),
			apiKey: OPENAI_KEY,
			extensionFactories: factories,
		});

		await harness.clientConn.initialize(stdInitParams);
		const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });
		await harness.clientConn.prompt({
			sessionId,
			prompt: [
				{
					type: "text",
					text: "Call the bodhi_echo tool with the message 'cli-extension-ok' and report what it returned.",
				},
			],
		});

		const flat = JSON.stringify(harness.updates);
		expect(flat).toContain("echoed: cli-extension-ok");
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});
