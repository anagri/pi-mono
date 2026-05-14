import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { expect, test } from "vitest";
import { createE2EHarness } from "../helpers/harness.js";
import { isRuntime } from "../helpers/runtime.js";
import { useHarness } from "../helpers/use-harness.js";

// Coverage for the public client.kv surface + recursive secret masking.
// KV values are arbitrary JSON. Secret markers `{value: string, secret: true}` are
// masked to `{value: "***", secret: true}` on read at any depth. Writing/removing
// an `auth/<provider>` key emits an `AuthChangeEvent` — asserted only under
// in-memory (where harness.events is populated synchronously by the in-process
// recorder). Under cli the event fires over stderr but is race-flaky; under http
// the extMethod path is JSON-on-JSON with no SSE channel.

const harness = useHarness();

test("kv: set/get/list/remove with recursive secret masking and AuthChangeEvent on auth/*", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: () => "ignored-no-prompts",
		}),
	);

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
	const setUser = await h.client.kv.set({ sessionId, key: userKey, value: "alice" });
	expect.soft(setUser.key).toBe(userKey);
	const getUser = await h.client.kv.get({ key: userKey });
	expect.soft(getUser.value).toBe("alice");

	// Step 2: provider auth blob — api_key masked on read, base_url visible.
	const authValue = {
		api_key: { value: "sk-PLAINTEXTSECRETXYZ", secret: true as const },
		base_url: "http://example.test/v1",
	};
	const setAuth = await h.client.kv.set({ sessionId, key: authKey, value: authValue });
	expect.soft(setAuth.key).toBe(authKey);
	const getAuth = await h.client.kv.get({ key: authKey });
	expect.soft(getAuth.value).toEqual({
		api_key: { value: "***", secret: true },
		base_url: "http://example.test/v1",
	});

	// Step 3: nested secret at a non-auth path — masking is recursive.
	await h.client.kv.set({
		sessionId,
		key: nestedKey,
		value: { deep: { token: { value: "deep-secret", secret: true, label: "kept" } }, public: "ok" },
	});
	const getNested = await h.client.kv.get({ key: nestedKey });
	expect.soft(getNested.value).toEqual({
		deep: { token: { value: "***", secret: true, label: "kept" } },
		public: "ok",
	});

	// Step 4: prefix-filtered list narrows to the auth key; secret nodes masked.
	const listAuth = await h.client.kv.list({ prefix: authKey });
	expect.soft(listAuth.entries.length).toBe(1);
	expect.soft(listAuth.entries[0]?.key).toBe(authKey);
	expect.soft(listAuth.entries[0]?.value).toEqual({
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
	const removeAuth = await h.client.kv.remove({ sessionId, key: authKey });
	expect.soft(removeAuth.key).toBe(authKey);
	const getAuthAfter = await h.client.kv.get({ key: authKey });
	expect.soft(getAuthAfter.value).toBeNull();
	const listAuthAfter = await h.client.kv.list({ prefix: authKey });
	expect.soft(listAuthAfter.entries.length).toBe(0);

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
	await h.client.kv.remove({ sessionId, key: userKey });
	await h.client.kv.remove({ sessionId, key: nestedKey });
});
