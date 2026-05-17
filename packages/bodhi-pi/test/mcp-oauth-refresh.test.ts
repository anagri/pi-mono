import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createBodhiPiClient } from "@/client/client.js";
import type { BodhiPiAcpConnection } from "@/client/types.js";
import { spawnOAuthMcpServer } from "../e2e/helpers/oauth-mcp-server.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness, type TestHarness } from "./helpers/harness.js";

let providers: FauxProviderRegistration[] = [];

beforeEach(() => {
	providers = [];
});
afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function newFaux(): Model<Api> {
	const faux = registerFauxProvider();
	providers.push(faux);
	faux.setResponses([() => fauxAssistantMessage("ok")]);
	return faux.getModel() as Model<Api>;
}

function bindClient(harness: TestHarness) {
	return createBodhiPiClient(harness.clientConn as unknown as BodhiPiAcpConnection);
}

test("eager refresh: 1s-expiry token swaps out before next request (no 401)", async () => {
	const port = 33820;
	const fixture = await spawnOAuthMcpServer({ port, expiresInSeconds: 1 });
	try {
		const model = newFaux();
		const harness = createTestHarness({ models: [model], defaultModelId: model.id });
		const client = bindClient(harness);
		await client.initialize(stdInitParams);
		await client.newSession({ cwd: "/proj" });

		await client.mcpAdd({
			url: fixture.mcpUrl,
			auth: "oauth-preregistered",
			authorizeUrl: fixture.authorizeUrl,
			tokenUrl: fixture.tokenUrl,
			clientId: fixture.clientId,
			clientSecret: fixture.clientSecret,
			redirectUri: "http://localhost:7777/callback",
			label: "oauthfix-refresh",
		});

		const slug = "localhost";
		const start = await client.mcpOauthStart({ slug });
		const u = new URL(start.authorizeUrl!);
		u.searchParams.set("auto", "1");
		const resp = await fetch(u.toString(), { redirect: "manual" });
		const cb = new URL(resp.headers.get("location")!);
		const code = cb.searchParams.get("code")!;
		await client.mcpOauthFinish({ slug, code, state: start.state! });

		// First connect runs `tools/list` which fires the attacher fetch wrapper. With 1s expiry
		// and 60s eager-refresh slack, EVERY request refreshes — so the bearer count climbs by
		// at least 1 per outbound request. We assert that monotonic growth, which is the
		// load-bearing property: refresh actually happens, and the new token actually flows.
		await client.mcpConnect({ slug });
		const firstBearerCount = fixture.uniqueBearerCount();
		expect(firstBearerCount).toBeGreaterThan(0);

		// Sleep past the 1-second expiry (60s slack would normally cover this, so eager kicks in
		// immediately on the next request — but we add an extra second to also trip the actual
		// expiry, so even if eager misses, the underlying token would be invalid).
		await client.mcpDisconnect({ slug });
		await new Promise((r) => setTimeout(r, 1500));

		// Reconnect — the next outbound request goes through the attacher's fetch wrapper.
		// Eager refresh sees expiresAt is past → calls refresh → fixture mints another token.
		// Bearer count keeps climbing.
		await client.mcpConnect({ slug });
		expect(fixture.uniqueBearerCount()).toBeGreaterThan(firstBearerCount);

		await client.mcpDisconnect({ slug });
	} finally {
		await fixture.close();
	}
}, 15_000);
