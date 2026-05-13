import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { afterEach, expect, test } from "vitest";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";
import { isRuntime } from "../helpers/runtime.js";

// Coverage for `_bodhi-pi/kv/{set,get,list,remove}` + secrets masking.
// Non-secret values flow through verbatim; secret values are masked to `***`
// on read. Writing/removing an `auth/<provider>` key emits an `AuthChangeEvent`
// — asserted only under in-memory (where `harness.events` is populated
// synchronously by the in-process recorder). Under cli the event also fires
// over stderr but the response race makes assertion flaky; under http the
// extMethod path is JSON-on-JSON with no SSE channel so the event never
// reaches the client.

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

test("kv: set/get/list/remove with secrets masking and AuthChangeEvent on auth/*", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: () => "ignored-no-prompts",
	});
	activeHarness = h;

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	// http's test-app-server shares a single on-disk kv store across all
	// per-user sessions (sqlite is per-user; kvStore is not). Use a per-run
	// suffix on every key so concurrent / sequential http tests don't bleed
	// into each other.
	const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	const userKey = `user/${tag}/name`;
	const provider = `kvtest-${tag}`;
	const authKey = `auth/${provider}`;

	// Step 1: non-secret key set — value returned verbatim on read.
	let r = await h.clientConn.extMethod(KV_SET, { sessionId, key: userKey, value: "alice" });
	expect.soft(r.key).toBe(userKey);
	expect.soft(r.secret).toBe(false);
	r = await h.clientConn.extMethod(KV_GET, { key: userKey });
	expect.soft(r.value).toBe("alice");
	expect.soft(r.secret).toBe(false);

	// Step 2: secret key set — `get` returns the `***` mask.
	r = await h.clientConn.extMethod(KV_SET, {
		sessionId,
		key: authKey,
		value: "sk-PLAINTEXTSECRETXYZ",
		secret: true,
	});
	expect.soft(r.secret).toBe(true);
	r = await h.clientConn.extMethod(KV_GET, { key: authKey });
	expect.soft(r.value).toBe("***");
	expect.soft(r.secret).toBe(true);

	// Step 3: prefix-filtered list narrows to our auth key; secret value masked.
	r = await h.clientConn.extMethod(KV_LIST, { prefix: authKey });
	const authEntries = r.entries as Array<{ key: string; value: string; secret: boolean }>;
	expect.soft(authEntries.length).toBe(1);
	expect.soft(authEntries[0]?.key).toBe(authKey);
	expect.soft(authEntries[0]?.value).toBe("***");

	// Step 4: AuthChangeEvent observed in-process for the auth/* write.
	if (isRuntime("in-memory")) {
		const login = h.events.find(
			(e) => e.type === "auth_change" && (e as { provider?: string }).provider === provider,
		);
		expect.soft(login, `auth_change(login) for ${provider}`).toBeDefined();
	}

	// Step 5: remove the auth key — get returns null, prefix-list drops it.
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

	// Step 6: clean up the non-secret key so the http server's shared kvStore
	// doesn't accrue stale entries across runs.
	await h.clientConn.extMethod(KV_REMOVE, { sessionId, key: userKey });
});
