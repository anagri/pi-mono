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

async function completeOauthFlow(
	client: ReturnType<typeof bindClient>,
	fixture: Awaited<ReturnType<typeof spawnOAuthMcpServer>>,
	label: string,
): Promise<string> {
	await client.mcpAdd({
		url: fixture.mcpUrl,
		auth: "oauth-preregistered",
		authorizeUrl: fixture.authorizeUrl,
		tokenUrl: fixture.tokenUrl,
		clientId: fixture.clientId,
		clientSecret: fixture.clientSecret,
		redirectUri: "http://localhost:7777/callback",
		label,
	});
	const slug = "localhost";
	const start = await client.mcpOauthStart({ slug });
	const u = new URL(start.authorizeUrl!);
	u.searchParams.set("auto", "1");
	const resp = await fetch(u.toString(), { redirect: "manual" });
	const cb = new URL(resp.headers.get("location")!);
	const code = cb.searchParams.get("code")!;
	await client.mcpOauthFinish({ slug, code, state: start.state! });
	return slug;
}

test("lazy refresh: forced 401 on protected request triggers refresh + retry with new bearer", async () => {
	const port = 33821;
	const fixture = await spawnOAuthMcpServer({ port });
	try {
		const model = newFaux();
		const harness = createTestHarness({ models: [model], defaultModelId: model.id });
		const client = bindClient(harness);
		await client.initialize(stdInitParams);
		await client.newSession({ cwd: "/proj" });

		const slug = await completeOauthFlow(client, fixture, "oauthfix-lazy");

		const connectResult = await client.mcpConnect({ slug });
		expect(connectResult.tools).toContain(`${slug}__whoami`);
		const bearersAfterConnect = fixture.uniqueBearerCount();
		expect(bearersAfterConnect).toBeGreaterThan(0);

		fixture.forceNext401();
		await client.mcpDisconnect({ slug });
		const reconnected = await client.mcpConnect({ slug });
		expect(reconnected.tools).toContain(`${slug}__whoami`);
		expect(fixture.uniqueBearerCount()).toBeGreaterThan(bearersAfterConnect);

		await client.mcpDisconnect({ slug });
	} finally {
		await fixture.close();
	}
}, 15_000);

test("refresh failure: tokens persist when refresh-grant errors so re-auth via oauth/start is possible", async () => {
	const port = 33822;
	const fixture = await spawnOAuthMcpServer({ port, expiresInSeconds: 1 });
	try {
		const model = newFaux();
		const harness = createTestHarness({ models: [model], defaultModelId: model.id });
		const client = bindClient(harness);
		await client.initialize(stdInitParams);
		await client.newSession({ cwd: "/proj" });

		const slug = await completeOauthFlow(client, fixture, "oauthfix-refresh-fail");

		await client.mcpConnect({ slug });

		const entryBeforeShutdown = (await client.mcpList()).find((e) => e.slug === slug);
		expect(entryBeforeShutdown).toBeDefined();
		await client.mcpDisconnect({ slug });

		await fixture.close();

		await expect(client.mcpConnect({ slug })).rejects.toBeDefined();

		const entryAfterFailure = (await client.mcpList()).find((e) => e.slug === slug);
		expect(entryAfterFailure).toBeDefined();
		expect(entryAfterFailure?.auth).toBeDefined();
	} finally {
		try {
			await fixture.close();
		} catch {}
	}
}, 15_000);
