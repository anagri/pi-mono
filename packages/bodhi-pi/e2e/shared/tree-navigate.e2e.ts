import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { afterEach, expect, test } from "vitest";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

test("/tree lists all entries with a single leaf marker; /goto moves the leaf and the next prompt branches from there", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const apiKey = process.env.OPENAI_API_KEY!;
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
	});
	activeHarness = h;

	await h.client.initialize(stdInitParams);
	const { sessionId } = await h.client.newSession({ cwd: h.cwd, mcpServers: [] });

	await h.client.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply only with: first" }],
	});
	await h.client.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply only with: second" }],
	});

	const tree = await h.client.getSessionTree({ sessionId });
	expect(tree.nodes.length).toBeGreaterThan(0);
	expect(tree.nodes.filter((n) => n.isLeaf)).toHaveLength(1);

	const entries = await h.client.listSessionEntries({ sessionId });
	const firstUserId = entries.entries.find((e) => e.role === "user" && e.preview.toLowerCase().includes("first"))?.id;
	expect(firstUserId).toBeDefined();
	if (!firstUserId) throw new Error("expected first user entry");

	const nav = await h.client.navigateSession({
		sessionId,
		targetEntryId: firstUserId,
	});
	// Cross-branch /goto auto-appends a branch_summary; leafId points there now.
	expect(typeof nav.leafId).toBe("string");
	expect(nav.leafId).not.toBe(firstUserId);

	await h.client.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply only with: branch" }],
	});

	const after = await h.client.listSessionEntries({ sessionId });
	const previews = after.entries.map((e) => e.preview.toLowerCase());
	expect(previews.some((p) => p.includes("first"))).toBe(true);
	expect(previews.some((p) => p.includes("branch"))).toBe(true);
	expect(previews.some((p) => p.includes("second"))).toBe(false);
});
