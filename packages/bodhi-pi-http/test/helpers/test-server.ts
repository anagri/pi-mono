import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type FauxProviderRegistration, registerFauxProvider } from "@earendil-works/pi-ai";
import { buildServer, type ServerHandle } from "../../src/server/server.js";

export interface TestServer {
	server: ServerHandle;
	dataDir: string;
	faux: FauxProviderRegistration;
	url: string;
	cleanup: () => Promise<void>;
}

export interface StartTestServerOptions {
	/** When set, every request uses this dir as cwd (CLI `--workspace` analog). */
	workspaceOverride?: string;
	/** Faux provider streaming speed (tokens/sec). Default: instant. */
	tokensPerSecond?: number;
}

export interface RpcCall {
	method: string;
	params?: Record<string, unknown>;
	id?: number | string;
}

export interface RpcResponse<T = unknown> {
	jsonrpc: "2.0";
	id: number | string | null;
	result: T;
}

export interface RpcErrorResponse {
	jsonrpc: "2.0";
	id: number | string | null;
	error: { code: number; message: string };
}

export async function rpc<T = unknown>(url: string, token: string, call: RpcCall): Promise<RpcResponse<T>> {
	const id = call.id ?? Math.floor(Math.random() * 1_000_000);
	const res = await fetch(`${url}/acp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id, method: call.method, params: call.params ?? {} }),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
	}
	const body = (await res.json()) as RpcResponse<T> | RpcErrorResponse;
	if ("error" in body) {
		throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
	}
	return body;
}

export async function startTestServer(opts: StartTestServerOptions = {}): Promise<TestServer> {
	const dataDir = mkdtempSync(path.join(os.tmpdir(), "bodhi-pi-http-test-"));
	const faux = registerFauxProvider(
		opts.tokensPerSecond !== undefined ? { tokensPerSecond: opts.tokensPerSecond } : {},
	);
	const fauxModel = faux.getModel();
	if (!fauxModel) throw new Error("faux provider did not return a model");

	const server = await buildServer({
		port: 0,
		dataDir,
		models: [fauxModel],
		defaultModelId: fauxModel.id,
		// Faux providers ignore the actual key value but the compaction path requires a non-undefined result.
		getApiKey: () => "test-key",
		// Tests don't need static asset serving and the dist/public dir often isn't present.
		staticDir: null,
		...(opts.workspaceOverride !== undefined ? { workspaceOverride: opts.workspaceOverride } : {}),
	});

	const url = `http://localhost:${server.port()}`;
	return {
		server,
		dataDir,
		faux,
		url,
		cleanup: async () => {
			await server.close();
			faux.unregister();
			rmSync(dataDir, { recursive: true, force: true });
		},
	};
}
