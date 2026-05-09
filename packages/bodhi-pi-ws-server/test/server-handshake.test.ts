import type { Client } from "@agentclientprotocol/sdk";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { encodeToken } from "../src/auth/token.js";
import { SUBPROTOCOL } from "../src/auth/upgrade.js";
import { buildServer, type ServerHandle } from "../src/server.js";
import { wsToStream } from "../src/transport/ws-stream.js";

class TestClient implements Client {
	async requestPermission() {
		throw new Error("test client should not be asked for permission");
	}
	async sessionUpdate() {
		// no-op for handshake test
	}
}

function connectClient(port: number, subprotocols: string[]): Promise<{ ws: WebSocket; conn: ClientSideConnection }> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${port}/agent`, subprotocols);
		ws.once("open", () => {
			const stream = wsToStream(ws as unknown as WebSocket);
			const acpStream = ndJsonStream(stream.writable, stream.readable);
			const conn = new ClientSideConnection(() => new TestClient(), acpStream);
			resolve({ ws, conn });
		});
		ws.once("error", reject);
		ws.once("unexpected-response", (_req, res) => {
			reject(new Error(`unexpected-response: ${res.statusCode}`));
		});
	});
}

describe("server handshake", () => {
	let server: ServerHandle;

	beforeEach(async () => {
		server = await buildServer({ port: 0 });
	});

	afterEach(async () => {
		await server.close();
	});

	it("accepts a valid bearer subprotocol and returns ACP initialize", async () => {
		const token = encodeToken({ id: 1, email: "alice@example.com" });
		const { ws, conn } = await connectClient(server.port(), [SUBPROTOCOL, `bearer.${token}`]);
		expect((ws as unknown as { protocol: string }).protocol).toBe(SUBPROTOCOL);

		const result = await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		expect(result.protocolVersion).toBe(1);
		expect(result.agentInfo?.name).toBe("bodhi-pi-ws");
		expect(result.authMethods).toEqual([]);

		ws.close();
	});

	it("rejects connection missing bearer subprotocol", async () => {
		await expect(connectClient(server.port(), [SUBPROTOCOL])).rejects.toThrow(/401|unexpected-response/i);
	});

	it("rejects connection with malformed bearer token", async () => {
		await expect(connectClient(server.port(), [SUBPROTOCOL, "bearer.!!!notbase64!!!"])).rejects.toThrow(
			/401|unexpected-response/i,
		);
	});

	it("rejects connection with no subprotocol header", async () => {
		await expect(connectClient(server.port(), [])).rejects.toThrow();
	});

	it("answers /healthz over plain HTTP", async () => {
		const res = await fetch(`http://localhost:${server.port()}/healthz`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});
});
