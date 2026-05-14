// Sidechannel for the page-side slash router to query the worker's ZenFS
// (the SUT for the agent). Each query posts a {type:"bodhi-pi-fs-query",id,
// op, path} message and awaits a {type:"bodhi-pi-fs-reply",id,...} reply.

import type { FsQueryMessage, FsReplyMessage, WorkerMessage } from "@e2e/app-utils/browser/runtime/types";

interface PendingQuery {
	resolve: (value: { ok: boolean; content?: string; exists?: boolean; error?: string }) => void;
}

const pending = new Map<number, PendingQuery>();
let nextId = 1;
let bound: Worker | null = null;

export function bindFsBridge(worker: Worker): void {
	bound = worker;
	worker.addEventListener("message", (ev: MessageEvent<WorkerMessage>) => {
		if (!ev.data || ev.data.type !== "bodhi-pi-fs-reply") return;
		const reply = ev.data as FsReplyMessage;
		const p = pending.get(reply.id);
		if (!p) return;
		pending.delete(reply.id);
		p.resolve({
			ok: reply.ok,
			content: reply.content,
			exists: reply.exists,
			error: reply.error,
		});
	});
}

function send(
	op: "read" | "exists",
	path: string,
): Promise<{ ok: boolean; content?: string; exists?: boolean; error?: string }> {
	if (!bound) {
		return Promise.resolve({ ok: false, error: "fs bridge not bound (worker not initialised)" });
	}
	const id = nextId++;
	const msg: FsQueryMessage = { type: "bodhi-pi-fs-query", id, op, path };
	return new Promise((resolve) => {
		pending.set(id, { resolve });
		(bound as Worker).postMessage(msg);
	});
}

export async function readWorkerFile(path: string): Promise<{ ok: boolean; content?: string; error?: string }> {
	const r = await send("read", path);
	return { ok: r.ok, content: r.content, error: r.error };
}

export async function workerFileExists(path: string): Promise<boolean> {
	const r = await send("exists", path);
	return r.ok && !!r.exists;
}
