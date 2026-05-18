import { type Api, type FauxProviderRegistration, type Model, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, EXT_SUBAGENT_RUN } from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { seedSubagent } from "./helpers/filesystem.js";
import { createTestHarness } from "./helpers/harness.js";

let providers: FauxProviderRegistration[] = [];

beforeEach(() => {
	providers = [];
});

afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function newProvider(): FauxProviderRegistration {
	const p = registerFauxProvider();
	providers.push(p);
	return p;
}

test("subagent whose first response throws lands status='failed' on subagent_complete with error set", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "crash", "---\ndescription: crash\n---\nYou crash.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		() => {
			throw new Error("forced provider failure");
		},
	]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = (await harness.clientConn.extMethod(EXT_SUBAGENT_RUN, {
		sessionId,
		agent: "crash",
		task: "should fail",
	})) as { childSessionId: string; status: string; error?: string };

	expect(result.status).toBe("failed");
	expect(result.error, "expected an error message in the failed result").toBeTruthy();

	const childRecord = await harness.sessionStore.load(result.childSessionId);
	expect(childRecord).toBeDefined();
	const completeEntry = childRecord!.entries.find((e) => e.type === "subagent_complete");
	expect(completeEntry, "expected a subagent_complete entry on the child").toBeDefined();
	expect(completeEntry).toMatchObject({ type: "subagent_complete", status: "failed" });
	expect((completeEntry as { error?: string }).error).toBeTruthy();

	// Re-spawning into the SAME childSessionId would error if the child were still loaded as a parent.
	// We expect it to be unknown — the child was evicted from `this.sessions` regardless of failure status.
	await expect(
		harness.clientConn.extMethod(EXT_SUBAGENT_RUN, {
			sessionId: result.childSessionId,
			agent: "crash",
			task: "second attempt",
		}),
	).rejects.toThrow(/not loaded/);
});
