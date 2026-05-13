// ported from packages/bodhi-pi-browser/src/sandbox/sandbox-bridge.ts

/**
 * Request/reply RPC over a `MessagePort` connecting the bodhi-pi worker to a
 * sandboxed iframe. Used by hosts under a strict CSP (MV3 chrome extensions)
 * where the worker realm cannot use `AsyncFunction` or `data:` ESM imports.
 *
 * Wire shape (worker → sandbox):
 *   { id, type: "load-extension", code }
 *     → { id, ok: true,  result: { registrations: [{ handlerId, eventType }] } }
 *     | { id, ok: false, error }
 *   { id, type: "invoke-handler", handlerId, event }
 *     → { id, ok: true,  result }
 *     | { id, ok: false, error }
 *   { id, type: "run-script", code, args, cwd, timeout }
 *     → { id, ok: true,  result: { stdout, stderr, exitCode } }
 *     | { id, ok: false, error }
 */

export interface ExtensionRegistration {
	handlerId: string;
	eventType: string;
}

export interface ExtensionLoadResult {
	registrations: ExtensionRegistration[];
}

export interface ScriptResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface SandboxBridge {
	loadExtension(code: string): Promise<ExtensionLoadResult>;
	invokeHandler(handlerId: string, event: unknown): Promise<unknown>;
	runScript(req: { code: string; args: string[]; cwd: string; timeout?: number }): Promise<ScriptResult>;
	dispose(): void;
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

export function createSandboxBridge(port: MessagePort): SandboxBridge {
	const pending = new Map<string, PendingCall>();
	let nextId = 1;

	port.onmessage = (ev: MessageEvent) => {
		const msg = ev.data as { id?: string; ok?: boolean; result?: unknown; error?: string } | undefined;
		if (!msg || typeof msg.id !== "string") return;
		const slot = pending.get(msg.id);
		if (!slot) return;
		pending.delete(msg.id);
		if (msg.ok) slot.resolve(msg.result);
		else slot.reject(new Error(msg.error ?? "sandbox call failed"));
	};
	port.start?.();

	function call<T>(type: string, payload: Record<string, unknown>): Promise<T> {
		const id = `c${nextId++}`;
		return new Promise<T>((resolve, reject) => {
			pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			port.postMessage({ id, type, ...payload });
		});
	}

	return {
		loadExtension(code) {
			return call<ExtensionLoadResult>("load-extension", { code });
		},
		invokeHandler(handlerId, event) {
			return call<unknown>("invoke-handler", { handlerId, event });
		},
		runScript(req) {
			return call<ScriptResult>("run-script", {
				code: req.code,
				args: req.args,
				cwd: req.cwd,
				...(req.timeout !== undefined ? { timeout: req.timeout } : {}),
			});
		},
		dispose() {
			port.onmessage = null;
			for (const slot of pending.values()) slot.reject(new Error("sandbox bridge disposed"));
			pending.clear();
		},
	};
}
