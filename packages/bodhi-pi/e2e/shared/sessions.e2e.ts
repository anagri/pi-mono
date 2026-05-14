import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { isRuntime } from "../helpers/runtime.js";
import { useHarness } from "../helpers/use-harness.js";

// End-to-end coverage for the session-lifecycle ACP methods beyond the
// new/fork/clone surface that fork-clone.e2e.ts exercises: listSessions,
// closeSession, resumeSession, and `client.deleteSession`. One flow with
// gpt-4o-mini drives all of them across two concurrent sessions;
// `expect.soft` keeps later steps running on failure.

const harness = useHarness();

test("sessions: list, close (record kept), resume (history rehydrated), delete (record gone)", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
		}),
	);

	await h.clientConn.initialize(stdInitParams);

	// Session A — anchor a fact in the model history so /resume can prove it.
	const { sessionId: sidA } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	h.updates.length = 0;
	await h.clientConn.prompt({
		sessionId: sidA,
		prompt: [
			{
				type: "text",
				text: "Remember this for later: my favorite color is amber. Reply only with the word OK.",
			},
		],
	});
	expect.soft(chunkedAgentText(h.updates).toLowerCase()).toContain("ok");

	// Session B — distinct concurrent session.
	const { sessionId: sidB } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	// List should show both records, scoped to this harness's workspace.
	let list = await h.clientConn.listSessions({ cwd: h.cwd });
	let ids = list.sessions.map((s) => s.sessionId);
	expect.soft(ids).toContain(sidA);
	expect.soft(ids).toContain(sidB);

	// closeSession evicts the in-memory runtime but keeps the persisted record.
	await h.clientConn.closeSession({ sessionId: sidA });
	list = await h.clientConn.listSessions({ cwd: h.cwd });
	ids = list.sessions.map((s) => s.sessionId);
	expect.soft(ids, "closed session still listed (record persists)").toContain(sidA);

	// resumeSession rehydrates from the store; subsequent prompt has the
	// earlier turn in context. Under http, the server resumes implicitly
	// before every sessionId-bound request, so the explicit RPC is not
	// exposed — rely on the next prompt to rehydrate.
	if (!isRuntime("http")) {
		await h.clientConn.resumeSession({ sessionId: sidA, cwd: h.cwd });
	}
	h.updates.length = 0;
	const recallResult = await h.clientConn.prompt({
		sessionId: sidA,
		prompt: [{ type: "text", text: "What is my favorite color? Reply with the single word." }],
	});
	expect.soft(recallResult.stopReason).toBe("end_turn");
	expect.soft(chunkedAgentText(h.updates).toLowerCase()).toContain("amber");

	// client.deleteSession permanently removes the record from the store.
	await h.client.deleteSession({ sessionId: sidA });
	list = await h.clientConn.listSessions({ cwd: h.cwd });
	ids = list.sessions.map((s) => s.sessionId);
	expect.soft(ids, "deleted session is gone from the store").not.toContain(sidA);
	expect.soft(ids, "sibling session remains").toContain(sidB);
});
