// Page-side slash commands intercept harness requests typed into acp-input
// before they reach the agent: they query the worker-side ZenFS (the agent's
// own filesystem) via the fs bridge and emit a synthetic response frame so
// the Node-side filesystem proxy can scrape post-prompt readback through the
// same DOM path as ACP responses.
//
// The slash form is the FIRST line of the textarea: "/file <path>" or
// "/exists <path>". Anything else is treated as a JSON-RPC body.

import { readWorkerFile, workerFileExists } from "./worker-fs-bridge";

export interface SlashResult {
	method: string;
	result: unknown;
}

export async function tryHandleSlash(raw: string): Promise<SlashResult | null> {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("/")) return null;
	const firstSpace = trimmed.indexOf(" ");
	const cmd = firstSpace === -1 ? trimmed : trimmed.substring(0, firstSpace);
	const arg = firstSpace === -1 ? "" : trimmed.substring(firstSpace + 1).trim();
	switch (cmd) {
		case "/file": {
			if (!arg) throw new Error("/file requires a path argument");
			const r = await readWorkerFile(arg);
			return {
				method: "_test/file/read",
				result: r.ok ? { ok: true, content: r.content } : { ok: false, error: r.error ?? "not found" },
			};
		}
		case "/exists": {
			if (!arg) throw new Error("/exists requires a path argument");
			const exists = await workerFileExists(arg);
			return { method: "_test/file/exists", result: { ok: true, exists } };
		}
		default:
			return null;
	}
}
