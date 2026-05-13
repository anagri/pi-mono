// ported from packages/bodhi-pi-chrome-ext/src/sandbox/sandbox.ts —
// extended with registerTool / registerCommand / registerProvider proxies
// (the e2e bridge surface is wider than production chrome-ext today so the
// shared extensions.e2e.ts suite can run end-to-end under MV3 CSP).

/**
 * Sandbox iframe entrypoint for the chrome-extension host. Receives a
 * MessagePort from the parent and services `load-extension`,
 * `invoke-handler`, `invoke-tool`, `get-provider-api-key`, and `run-script`
 * requests issued by the agent worker. MV3 extension pages forbid
 * `unsafe-eval`; this sandboxed page does not.
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

interface EventReg {
	handlerId: string;
	eventType: string;
}

interface ToolReg {
	toolId: string;
	name: string;
	description: string;
	parameters: unknown;
}

interface CommandReg {
	commandId: string;
	name: string;
	description: string;
	argumentHint?: string;
	template: string;
}

interface ProviderReg {
	providerId: string;
	name: string;
	model: unknown;
	hasGetApiKey: boolean;
}

interface ToolDef {
	execute: (toolCallId: string, params: unknown) => unknown | Promise<unknown>;
}

interface ProviderDef {
	getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
}

let port: MessagePort | null = null;
const handlers = new Map<string, (event: unknown) => unknown | Promise<unknown>>();
const tools = new Map<string, ToolDef>();
const providers = new Map<string, ProviderDef>();
let nextHandlerId = 1;
let nextToolId = 1;
let nextCommandId = 1;
let nextProviderId = 1;

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

interface CollectedRegistrations {
	events: EventReg[];
	tools: ToolReg[];
	commands: CommandReg[];
	providers: ProviderReg[];
}

function makePiProxy(collected: CollectedRegistrations) {
	return {
		on(type: string, handler: (event: unknown) => unknown | Promise<unknown>) {
			const handlerId = `h${nextHandlerId++}`;
			handlers.set(handlerId, handler);
			collected.events.push({ handlerId, eventType: type });
			return () => {
				handlers.delete(handlerId);
			};
		},
		registerTool(def: {
			name: string;
			description: string;
			parameters: unknown;
			execute: (toolCallId: string, params: unknown) => unknown | Promise<unknown>;
		}): () => void {
			const toolId = `t${nextToolId++}`;
			tools.set(toolId, { execute: def.execute });
			collected.tools.push({
				toolId,
				name: def.name,
				description: def.description,
				parameters: def.parameters,
			});
			return () => {
				tools.delete(toolId);
			};
		},
		registerCommand(name: string, def: { description: string; argumentHint?: string; template: string }): () => void {
			const commandId = `c${nextCommandId++}`;
			collected.commands.push({
				commandId,
				name,
				description: def.description,
				...(def.argumentHint !== undefined ? { argumentHint: def.argumentHint } : {}),
				template: def.template,
			});
			return () => {
				// no-op: the worker side owns the registry; un-register is best-effort
			};
		},
		registerProvider(name: string, config: { model: unknown; getApiKey?: (p: string) => unknown }): () => void {
			const providerId = `p${nextProviderId++}`;
			providers.set(providerId, { getApiKey: config.getApiKey as ProviderDef["getApiKey"] });
			collected.providers.push({
				providerId,
				name,
				model: config.model,
				hasGetApiKey: typeof config.getApiKey === "function",
			});
			return () => {
				providers.delete(providerId);
			};
		},
		events: {
			emit() {},
			on() {
				return () => {};
			},
		},
		appendEntry: async () => {},
		sendMessage: async () => {},
		requestSlashableRefresh: async () => {},
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
			const collected: CollectedRegistrations = { events: [], tools: [], commands: [], providers: [] };
			await (factory as (pi: unknown) => unknown)(makePiProxy(collected));
			send({
				id: msg.id,
				ok: true,
				result: {
					registrations: collected.events,
					tools: collected.tools,
					commands: collected.commands,
					providers: collected.providers,
				},
			});
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

	if (msg.type === "invoke-tool") {
		const toolId = msg.toolId as string;
		const callId = msg.callId as string;
		const params = msg.params;
		const tool = tools.get(toolId);
		if (!tool) {
			send({ id: msg.id, ok: false, error: `unknown toolId ${toolId}` });
			return;
		}
		try {
			const result = await tool.execute(callId, params);
			send({ id: msg.id, ok: true, result });
		} catch (err) {
			send({ id: msg.id, ok: false, error: errorString(err) });
		}
		return;
	}

	if (msg.type === "get-provider-api-key") {
		const providerId = msg.providerId as string;
		const provider = msg.provider as string;
		const prov = providers.get(providerId);
		if (!prov || !prov.getApiKey) {
			send({ id: msg.id, ok: true, result: undefined });
			return;
		}
		try {
			const key = await prov.getApiKey(provider);
			send({ id: msg.id, ok: true, result: key });
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
