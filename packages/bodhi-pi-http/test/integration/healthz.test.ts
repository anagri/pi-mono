import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "../helpers/test-server.js";

describe("healthz", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("returns 200 ok", async () => {
		const res = await fetch(`${ts.url}/healthz`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	it("returns 404 for unknown paths", async () => {
		const res = await fetch(`${ts.url}/nope`);
		expect(res.status).toBe(404);
	});
});
