import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { startTestServer, type TestServer } from "../helpers/test-server.js";

describe("POST /acp — initialize", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("returns 401 without bearer", async () => {
		const res = await fetch(`${ts.url}/acp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: 1, clientCapabilities: {} },
			}),
		});
		expect(res.status).toBe(401);
	});

	it("returns 401 with malformed bearer", async () => {
		const res = await fetch(`${ts.url}/acp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer !!!notbase64!!!",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: 1, clientCapabilities: {} },
			}),
		});
		expect(res.status).toBe(401);
	});

	it("dispatches initialize and returns ACP capability response", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const res = await fetch(`${ts.url}/acp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${tok}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: 1, clientCapabilities: {} },
			}),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/application\/json/);
		const body: unknown = await res.json();
		expect(body).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			result: {
				protocolVersion: 1,
				agentInfo: { name: "bodhi-pi" },
			},
		});
	});

	it("returns JSON-RPC error for unknown method", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const res = await fetch(`${ts.url}/acp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${tok}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "no/such/method",
				params: {},
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { jsonrpc: string; id: number; error?: { code: number } };
		expect(body.error).toBeDefined();
		expect(body.error?.code).toBe(-32601);
	});
});
