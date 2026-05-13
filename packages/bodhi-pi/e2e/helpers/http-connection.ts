import type {
	InitializeRequest,
	InitializeResponse,
	ListSessionsRequest,
	ListSessionsResponse,
	LoadSessionRequest,
	LoadSessionResponse,
	NewSessionRequest,
	NewSessionResponse,
	PromptRequest,
	PromptResponse,
	ResumeSessionRequest,
	ResumeSessionResponse,
	SessionNotification,
	SetSessionConfigOptionRequest,
	SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type { BodhiPiAcpConnection, BodhiPiEvent } from "@/index.js";

const LIFECYCLE_EVENT_METHOD = "_bodhi-pi/lifecycle/event";

export interface HttpConnectionOptions {
	baseUrl: string;
	token: string;
	onUpdate: (notif: SessionNotification) => void;
	/** Receives every `_bodhi-pi/lifecycle/event` notification frame from the SSE stream. */
	onLifecycleEvent?: (ev: BodhiPiEvent) => void;
}

const SSE_METHODS = new Set(["session/prompt", "session/load"]);

let nextId = 1;

// Ported from packages/bodhi-pi-http/src/frontend/lib/{acp-http-client,sse-parser}.ts.
// `session/prompt` and `session/load` are SSE; everything else is JSON-on-JSON.
export class HttpAcpConnection implements BodhiPiAcpConnection {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly onUpdate: (notif: SessionNotification) => void;
	private readonly onLifecycleEvent: ((ev: BodhiPiEvent) => void) | undefined;

	constructor(opts: HttpConnectionOptions) {
		this.baseUrl = opts.baseUrl;
		this.token = opts.token;
		this.onUpdate = opts.onUpdate;
		this.onLifecycleEvent = opts.onLifecycleEvent;
	}

	initialize(params: InitializeRequest): Promise<InitializeResponse> {
		return this.call("initialize", params as unknown as Record<string, unknown>) as Promise<InitializeResponse>;
	}
	newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		return this.call("session/new", params as unknown as Record<string, unknown>) as Promise<NewSessionResponse>;
	}
	loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		return this.call("session/load", params as unknown as Record<string, unknown>) as Promise<LoadSessionResponse>;
	}
	resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		return this.call(
			"session/resume",
			params as unknown as Record<string, unknown>,
		) as Promise<ResumeSessionResponse>;
	}
	listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		return this.call("session/list", params as unknown as Record<string, unknown>) as Promise<ListSessionsResponse>;
	}
	async closeSession(params: { sessionId: string }): Promise<void> {
		await this.call("session/close", params as unknown as Record<string, unknown>);
	}
	setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		return this.call(
			"session/setSessionConfigOption",
			params as unknown as Record<string, unknown>,
		) as Promise<SetSessionConfigOptionResponse>;
	}
	prompt(params: PromptRequest): Promise<PromptResponse> {
		return this.call("session/prompt", params as unknown as Record<string, unknown>) as Promise<PromptResponse>;
	}
	async cancel(params: { sessionId: string }): Promise<void> {
		await this.call("session/cancel", params as unknown as Record<string, unknown>);
	}
	extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.call(method, params) as Promise<Record<string, unknown>>;
	}

	private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = nextId++;
		const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		const isSse = SSE_METHODS.has(method);
		const res = await fetch(`${this.baseUrl}/acp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: isSse ? "text/event-stream" : "application/json",
				authorization: `Bearer ${this.token}`,
			},
			body,
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
		}
		if (!isSse) {
			const json = (await res.json()) as
				| { jsonrpc: "2.0"; id: number; result: unknown }
				| { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data?: unknown } };
			if ("error" in json) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
			return json.result;
		}
		if (!res.body) throw new Error("SSE: no response body");
		let final: unknown;
		for await (const frame of parseSse(res.body)) {
			const f = frame as {
				method?: string;
				params?: unknown;
				id?: unknown;
				result?: unknown;
				error?: { code: number; message: string; data?: unknown };
			};
			if (typeof f.method === "string") {
				if (f.method === "session/update" && f.params) {
					this.onUpdate(f.params as SessionNotification);
				} else if (f.method === LIFECYCLE_EVENT_METHOD && f.params && this.onLifecycleEvent) {
					this.onLifecycleEvent(f.params as BodhiPiEvent);
				}
			} else if ("error" in f && f.error) {
				throw new Error(`RPC error ${f.error.code}: ${f.error.message}`);
			} else if ("result" in f && f.result !== undefined) {
				final = f.result;
			}
		}
		if (final === undefined) throw new Error("SSE stream ended without final response");
		return final;
	}
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (value) buffer += decoder.decode(value, { stream: !done });
			while (true) {
				const idx = buffer.indexOf("\n\n");
				if (idx === -1) break;
				const block = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const dataLines: string[] = [];
				for (const line of block.split("\n")) {
					if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
				}
				if (dataLines.length === 0) continue;
				yield JSON.parse(dataLines.join("\n")) as unknown;
			}
			if (done) {
				if (buffer.trim().length > 0) {
					const dataLines: string[] = [];
					for (const line of buffer.split("\n")) {
						if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
					}
					if (dataLines.length > 0) yield JSON.parse(dataLines.join("\n")) as unknown;
				}
				return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}
