import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { AUTH_PREFIX } from "@bodhiapp/bodhi-pi";
import { createNodeKvStore } from "@bodhiapp/bodhi-pi-test-app-node-adapters";
import { encodeToken } from "./auth/token.js";
import { ensureUserWorkspace } from "./filesystem/user-workspace.js";

interface ProvisionRequest {
	id: number;
	email: string;
	files?: Record<string, string>;
	apiKeys?: Record<string, string>;
	defaultModelId?: string;
}

interface ProvisionResponse {
	token: string;
	workspaceRoot: string;
	cwd: string;
}

export async function handleProvision(
	req: IncomingMessage,
	res: ServerResponse,
	opts: { dataDir: string; workspaceOverride?: string },
): Promise<void> {
	const body = await readJson(req);
	const parsed = parseProvisionRequest(body);
	if ("error" in parsed) {
		writeJson(res, 400, { error: parsed.error });
		return;
	}
	const { id, email, files, apiKeys, defaultModelId } = parsed;
	const cwd = opts.workspaceOverride ?? ensureUserWorkspace(opts.dataDir, id);
	if (files) {
		for (const [relPath, contents] of Object.entries(files)) {
			if (relPath.startsWith("/")) {
				writeJson(res, 400, { error: `seed file path must be relative: ${relPath}` });
				return;
			}
			const abs = path.resolve(cwd, relPath);
			if (!abs.startsWith(`${cwd}${path.sep}`) && abs !== cwd) {
				writeJson(res, 400, { error: `seed file escapes workspace: ${relPath}` });
				return;
			}
			mkdirSync(path.dirname(abs), { recursive: true });
			writeFileSync(abs, contents, "utf8");
		}
	}

	if (apiKeys && Object.keys(apiKeys).length > 0) {
		const kvDir = path.join(opts.dataDir, "kv", String(id));
		const kvStore = createNodeKvStore({ dir: kvDir });
		for (const [provider, value] of Object.entries(apiKeys)) {
			if (typeof value !== "string" || value.length === 0) continue;
			await kvStore.set(`${AUTH_PREFIX}${provider}`, { api_key: { value, secret: true } });
		}
	}

	if (defaultModelId) {
		const settingsDir = path.join(cwd, ".bodhi-pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ defaultModelId }, null, 2), "utf8");
	}

	const token = encodeToken({ id, email });
	const response: ProvisionResponse = { token, workspaceRoot: cwd, cwd };
	writeJson(res, 200, response);
}

function parseProvisionRequest(body: unknown): ProvisionRequest | { error: string } {
	if (typeof body !== "object" || body === null) return { error: "body must be a JSON object" };
	const obj = body as Record<string, unknown>;
	if (typeof obj.id !== "number" || !Number.isFinite(obj.id)) return { error: "id must be a finite number" };
	if (typeof obj.email !== "string" || obj.email.length === 0) return { error: "email must be a non-empty string" };
	if (obj.files !== undefined) {
		if (typeof obj.files !== "object" || obj.files === null) return { error: "files must be an object" };
		for (const v of Object.values(obj.files)) {
			if (typeof v !== "string") return { error: "files values must be strings" };
		}
	}
	if (obj.apiKeys !== undefined) {
		if (typeof obj.apiKeys !== "object" || obj.apiKeys === null) return { error: "apiKeys must be an object" };
		for (const v of Object.values(obj.apiKeys)) {
			if (typeof v !== "string") return { error: "apiKeys values must be strings" };
		}
	}
	if (obj.defaultModelId !== undefined && typeof obj.defaultModelId !== "string") {
		return { error: "defaultModelId must be a string" };
	}
	const out: ProvisionRequest = { id: obj.id, email: obj.email };
	if (obj.files) out.files = obj.files as Record<string, string>;
	if (obj.apiKeys) out.apiKeys = obj.apiKeys as Record<string, string>;
	if (obj.defaultModelId) out.defaultModelId = obj.defaultModelId as string;
	return out;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.length === 0) return null;
	return JSON.parse(text);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
	});
	res.end(text);
}
