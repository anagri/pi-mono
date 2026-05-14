import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { encodeToken } from "./auth/token.js";
import { ensureUserWorkspace } from "./filesystem/user-workspace.js";

interface ProvisionRequest {
	id: number;
	email: string;
	files?: Record<string, string>;
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
	const { id, email, files } = parsed;
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
	const out: ProvisionRequest = { id: obj.id, email: obj.email };
	if (obj.files) out.files = obj.files as Record<string, string>;
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
