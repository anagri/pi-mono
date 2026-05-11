import { EXT_SESSION_ENTRIES, EXT_SESSION_NAVIGATE, EXT_SESSION_TREE } from "@bodhiapp/bodhi-pi";
import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { afterEach, beforeEach, expect, test } from "vitest";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;

beforeEach(async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
});

afterEach(async () => {
	await harness.cleanup();
});

test("/tree lists all entries with a single leaf marker; /goto moves the leaf and the next prompt branches from there", async () => {
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply only with: first" }],
	});
	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply only with: second" }],
	});

	const tree = (await harness.clientConn.extMethod(EXT_SESSION_TREE, { sessionId })) as {
		leafId: string;
		nodes: { id: string; isLeaf: boolean; type: string }[];
	};
	expect(tree.nodes.length).toBeGreaterThan(0);
	expect(tree.nodes.filter((n) => n.isLeaf)).toHaveLength(1);

	const entries = (await harness.clientConn.extMethod(EXT_SESSION_ENTRIES, { sessionId })) as {
		entries: { id: string; role: string; preview: string }[];
	};
	const firstUserId = entries.entries.find((e) => e.role === "user" && e.preview.toLowerCase().includes("first"))?.id;
	expect(firstUserId).toBeDefined();

	const nav = (await harness.clientConn.extMethod(EXT_SESSION_NAVIGATE, {
		sessionId,
		targetEntryId: firstUserId,
	})) as { leafId: string };
	// Cross-branch /goto auto-appends a branch_summary; leafId points there now.
	expect(typeof nav.leafId).toBe("string");
	expect(nav.leafId).not.toBe(firstUserId);

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply only with: branch" }],
	});

	const after = (await harness.clientConn.extMethod(EXT_SESSION_ENTRIES, { sessionId })) as {
		entries: { preview: string }[];
	};
	const previews = after.entries.map((e) => e.preview.toLowerCase());
	expect(previews.some((p) => p.includes("first"))).toBe(true);
	expect(previews.some((p) => p.includes("branch"))).toBe(true);
	expect(previews.some((p) => p.includes("second"))).toBe(false);
}, 60_000);
