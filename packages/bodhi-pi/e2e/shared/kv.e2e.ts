import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { afterEach, expect, test } from "vitest";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";
import { isRuntime } from "../helpers/runtime.js";

// Coverage for `_bodhi-pi/kv/{set,get,list,remove}` + recursive secret masking.
// KV values are arbitrary JSON. Secret markers `{value: string, secret: true}` are
// masked to `{value: "***", secret: true}` on read at any depth. Writing/removing
// an `auth/<provider>` key emits an `AuthChangeEvent` — asserted only under
// in-memory (where harness.events is populated synchronously by the in-process
// recorder). Under cli the event fires over stderr but is race-flaky; under http
// the extMethod path is JSON-on-JSON with no SSE channel.

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

const KV_SET = "_bodhi-pi/kv/set";
const KV_GET = "_bodhi-pi/kv/get";
const KV_LIST = "_bodhi-pi/kv/list";
const KV_REMOVE = "_bodhi-pi/kv/remove";

test("kv: set/get/list/remove with recursive secret masking and AuthChangeEvent on auth/*", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: () => "ignored-no-prompts",
	});
	activeHarness = h;

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	// http's test-app-server shares a single on-disk kv store across all per-user
	// sessions (sqlite is per-user; kvStore is not). Per-run suffix avoids bleed.
	const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	const userKey = `user/${tag}/name`;
	const provider = `kvtest-${tag}`;
	const authKey = `auth/${provider}`;
	const nestedKey = `nested/${tag}`;

	// Step 1: non-secret JSON value — returned verbatim.
	let r = await h.clientConn.extMethod(KV_SET, { sessionId, key: userKey, value: "alice" });
	expect.soft(r.key).toBe(userKey);
	r = await h.clientConn.extMethod(KV_GET, { key: userKey });
	expect.soft(r.value).toBe("alice");

	// Step 2: provider auth blob — api_key masked on read, base_url visible.
	const authValue = {
		api_key: { value: "sk-PLAINTEXTSECRETXYZ", secret: true },
		base_url: "http://example.test/v1",
	};
	r = await h.clientConn.extMethod(KV_SET, { sessionId, key: authKey, value: authValue });
	expect.soft(r.key).toBe(authKey);
	r = await h.clientConn.extMethod(KV_GET, { key: authKey });
	expect.soft(r.value).toEqual({
		api_key: { value: "***", secret: true },
		base_url: "http://example.test/v1",
	});

	// Step 3: nested secret at a non-auth path — masking is recursive.
	r = await h.clientConn.extMethod(KV_SET, {
		sessionId,
		key: nestedKey,
		value: { deep: { token: { value: "deep-secret", secret: true, label: "kept" } }, public: "ok" },
	});
	r = await h.clientConn.extMethod(KV_GET, { key: nestedKey });
	expect.soft(r.value).toEqual({
		deep: { token: { value: "***", secret: true, label: "kept" } },
		public: "ok",
	});

	// Step 4: prefix-filtered list narrows to the auth key; secret nodes masked.
	r = await h.clientConn.extMethod(KV_LIST, { prefix: authKey });
	const authEntries = r.entries as Array<{ key: string; value: unknown }>;
	expect.soft(authEntries.length).toBe(1);
	expect.soft(authEntries[0]?.key).toBe(authKey);
	expect.soft(authEntries[0]?.value).toEqual({
		api_key: { value: "***", secret: true },
		base_url: "http://example.test/v1",
	});

	// Step 5: AuthChangeEvent observed in-process for the auth/* write.
	if (isRuntime("in-memory")) {
		const login = h.events.find(
			(e) => e.type === "auth_change" && (e as { provider?: string }).provider === provider,
		);
		expect.soft(login, `auth_change(login) for ${provider}`).toBeDefined();
	}

	// Step 6: remove the auth key — get returns null, prefix-list drops it.
	r = await h.clientConn.extMethod(KV_REMOVE, { sessionId, key: authKey });
	expect.soft(r.key).toBe(authKey);
	r = await h.clientConn.extMethod(KV_GET, { key: authKey });
	expect.soft(r.value).toBeNull();
	r = await h.clientConn.extMethod(KV_LIST, { prefix: authKey });
	expect.soft((r.entries as unknown[]).length).toBe(0);

	if (isRuntime("in-memory")) {
		const logout = h.events.find(
			(e) =>
				e.type === "auth_change" &&
				(e as { provider?: string }).provider === provider &&
				(e as { action?: string }).action === "logout",
		);
		expect.soft(logout, `auth_change(logout) for ${provider}`).toBeDefined();
	}

	// Step 7: clean up non-auth keys so http's shared kvStore doesn't accrue stale entries.
	await h.clientConn.extMethod(KV_REMOVE, { sessionId, key: userKey });
	await h.clientConn.extMethod(KV_REMOVE, { sessionId, key: nestedKey });
});
