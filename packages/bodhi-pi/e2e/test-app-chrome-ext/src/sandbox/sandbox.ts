// ported from packages/bodhi-pi-chrome-ext/src/sandbox/sandbox.ts

/**
 * Sandbox iframe entrypoint for the chrome-extension host. Receives a
 * MessagePort from the parent and services `load-extension`,
 * `invoke-handler`, and `run-script` requests issued by the agent worker.
 * MV3 extension pages forbid `unsafe-eval`; this sandboxed page does not.
 */

interface ConnectMessage {
	type: "connect";
	port: MessagePort;
}

interface RpcRequest {
	id: string;
	type: string;
	[k: string]: unknown;
}

interface RpcResponse {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

const AsyncFunctionCtor = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

let port: MessagePort | null = null;
const handlers = new Map<string, (event: unknown) => unknown | Promise<unknown>>();
let nextHandlerId = 1;

window.addEventListener("message", (ev: MessageEvent<ConnectMessage>) => {
	if (ev.data?.type !== "connect") return;
	const incoming = ev.data.port;
	if (!(incoming instanceof MessagePort)) return;
	port = incoming;
	port.onmessage = onPortMessage;
	port.start?.();
});

window.parent?.postMessage({ type: "bodhi-pi-sandbox-ready" }, "*");

function send(msg: RpcResponse): void {
	port?.postMessage(msg);
}

function fmt(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack ?? value.message;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function makePiProxy(registrations: { handlerId: string; eventType: string }[]) {
	return {
		on(type: string, handler: (event: unknown) => unknown | Promise<unknown>) {
			const handlerId = `h${nextHandlerId++}`;
			handlers.set(handlerId, handler);
			registrations.push({ handlerId, eventType: type });
			return () => {
				handlers.delete(handlerId);
			};
		},
		registerTool(): () => void {
			throw new Error("registerTool is not supported in MV3 sandbox extensions yet");
		},
		registerCommand(): () => void {
			throw new Error("registerCommand is not supported in MV3 sandbox extensions yet");
		},
		registerProvider(): () => void {
			throw new Error("registerProvider is not supported in MV3 sandbox extensions yet");
		},
		events: {
			emit() {},
			on() {
				return () => {};
			},
		},
		appendEntry: async () => {},
		sendMessage: async () => {},
	};
}

async function onPortMessage(ev: MessageEvent<RpcRequest>): Promise<void> {
	const msg = ev.data;
	if (!msg || typeof msg !== "object" || typeof msg.id !== "string") return;

	if (msg.type === "load-extension") {
		const code = msg.code as string;
		try {
			const bytes = new TextEncoder().encode(code);
			const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
			const dataUrl = `data:text/javascript;base64,${btoa(binary)}`;
			const mod = await import(/* @vite-ignore */ dataUrl);
			const factory = (mod as { default?: unknown })?.default ?? mod;
			if (typeof factory !== "function") {
				send({ id: msg.id, ok: false, error: "default export is not a function" });
				return;
			}
			const registrations: { handlerId: string; eventType: string }[] = [];
			await (factory as (pi: unknown) => unknown)(makePiProxy(registrations));
			send({ id: msg.id, ok: true, result: { registrations } });
		} catch (err) {
			send({ id: msg.id, ok: false, error: errorString(err) });
		}
		return;
	}

	if (msg.type === "invoke-handler") {
		const handlerId = msg.handlerId as string;
		const event = msg.event;
		const handler = handlers.get(handlerId);
		if (!handler) {
			send({ id: msg.id, ok: false, error: `unknown handlerId ${handlerId}` });
			return;
		}
		try {
			const result = await handler(event);
			send({ id: msg.id, ok: true, result });
		} catch (err) {
			send({ id: msg.id, ok: false, error: errorString(err) });
		}
		return;
	}

	if (msg.type === "run-script") {
		await runScript(msg);
		return;
	}
}

async function runScript(msg: RpcRequest): Promise<void> {
	const code = msg.code as string;
	const args = (msg.args as string[] | undefined) ?? [];
	const cwd = (msg.cwd as string | undefined) ?? "/";
	const timeout = msg.timeout as number | undefined;

	const stdout: string[] = [];
	const stderr: string[] = [];
	const captured = {
		log: (...xs: unknown[]) => stdout.push(xs.map(fmt).join(" ")),
		error: (...xs: unknown[]) => stderr.push(xs.map(fmt).join(" ")),
		warn: (...xs: unknown[]) => stderr.push(xs.map(fmt).join(" ")),
		info: (...xs: unknown[]) => stdout.push(xs.map(fmt).join(" ")),
	};

	let fn: (args: string[], cwd: string, console: typeof captured) => Promise<unknown>;
	try {
		fn = new AsyncFunctionCtor("args", "cwd", "console", code) as typeof fn;
	} catch (err) {
		send({
			id: msg.id,
			ok: true,
			result: { stdout: "", stderr: `compile failed: ${(err as Error).message}`, exitCode: 1 },
		});
		return;
	}

	const run = fn(args, cwd, captured);

	let timer: ReturnType<typeof setTimeout> | undefined;
	const raced =
		typeof timeout === "number" && timeout > 0
			? Promise.race<unknown>([
					run,
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error(`script timed out after ${timeout}ms`)), timeout);
					}),
				])
			: run;

	try {
		await raced;
		send({
			id: msg.id,
			ok: true,
			result: { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode: 0 },
		});
	} catch (err) {
		const errText = err instanceof Error ? (err.stack ?? err.message) : String(err);
		const stderrText = [stderr.join("\n"), errText].filter(Boolean).join("\n");
		send({
			id: msg.id,
			ok: true,
			result: { stdout: stdout.join("\n"), stderr: stderrText, exitCode: 1 },
		});
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function errorString(err: unknown): string {
	if (err instanceof Error) return err.stack ?? err.message;
	return String(err);
}
