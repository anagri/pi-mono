// Page-side slash commands intercept harness requests typed into acp-input
// before they reach the agent: they read the in-page ZenFS directly and emit
// a synthetic response frame so the Node-side filesystem proxy can scrape
// post-prompt readback through the same DOM path as ACP responses.
//
// The slash form is the FIRST line of the textarea: "/file <path>" or
// "/exists <path>". Anything else is treated as a JSON-RPC body.

import { readWorkspaceFile, workspaceFileExists } from "./workspace-mount";

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
			try {
				const content = await readWorkspaceFile(arg);
				return { method: "_test/file/read", result: { ok: true, content } };
			} catch (err) {
				return {
					method: "_test/file/read",
					result: { ok: false, error: (err as Error).message ?? String(err) },
				};
			}
		}
		case "/exists": {
			if (!arg) throw new Error("/exists requires a path argument");
			const exists = await workspaceFileExists(arg);
			return { method: "_test/file/exists", result: { ok: true, exists } };
		}
		default:
			return null;
	}
}
