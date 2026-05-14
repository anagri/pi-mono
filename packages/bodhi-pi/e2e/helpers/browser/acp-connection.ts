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
import type { Page } from "playwright";
import type { BodhiPiAcpConnection, BodhiPiEvent } from "@/index.js";
import { readNewFramesAndEvents } from "./page-frame-reader.js";

// ACP transport over a Playwright-driven page. Each call writes a JSON-RPC
// request body into [data-testid="acp-input"], clicks acp-submit, then polls
// the DOM frame log for the matching response. Streaming methods
// (session/prompt, session/load, session/resume) dispatch session/update
// notifications to onUpdate as they arrive in-order via the data-frame-seq
// cursor. Lifecycle events flow through the page-side event-log; this
// connection reads them out of the worker-emitted DOM events.

export interface BrowserConnectionOptions {
	page: Page;
	onUpdate: (notif: SessionNotification) => void;
	onLifecycleEvent?: (ev: BodhiPiEvent) => void;
}

const LIFECYCLE_EVENT_METHOD = "_bodhi-pi/lifecycle/event";

export class BrowserAcpConnection implements BodhiPiAcpConnection {
	private readonly page: Page;
	private readonly onUpdate: (notif: SessionNotification) => void;
	private readonly onLifecycleEvent: ((ev: BodhiPiEvent) => void) | undefined;
	private lastFrameSeq = 0;
	private lastEventSeq = 0;
	// id in the body is informational only: the in-page SDK rewrites it.
	// Per-instance counter so two concurrent connections don't share state.
	private nextId = 1;

	constructor(opts: BrowserConnectionOptions) {
		this.page = opts.page;
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
		// Post session/cancel through the same acp-input + acp-submit channel as
		// every other method. The page's command handler forwards params.sessionId
		// to ClientSideConnection.cancel; the resulting frame surfaces in the same
		// DOM frame log we already poll.
		await this.call("session/cancel", params as unknown as Record<string, unknown>);
	}
	extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.call(method, params) as Promise<Record<string, unknown>>;
	}

	private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = this.nextId++;
		const body = { jsonrpc: "2.0", id, method, params };
		const startSeq = this.lastFrameSeq;
		await this.page.fill('[data-testid="acp-input"]', JSON.stringify(body));
		await this.page.click('[data-testid="acp-submit"]');

		return await this.pollForResponse({ method, startSeq });
	}

	private async pollForResponse(opts: { method: string; startSeq: number }): Promise<unknown> {
		const deadline = Date.now() + 60_000;
		let cursor = opts.startSeq;
		while (Date.now() < deadline) {
			const { frames, events } = await readNewFramesAndEvents(this.page, cursor, this.lastEventSeq);
			if (events.length > 0) this.lastEventSeq = events[events.length - 1].seq;
			for (const ev of events) {
				if (this.onLifecycleEvent) {
					try {
						const parsed = JSON.parse(ev.payload) as BodhiPiEvent;
						this.onLifecycleEvent(parsed);
					} catch {
						// non-JSON event payload — skip
					}
				}
			}
			for (const f of frames) {
				cursor = f.seq;
				if (f.direction !== "in") continue;
				if (f.kind === "notification") {
					try {
						const body = JSON.parse(f.payload) as { method?: string; params?: unknown };
						if (body.method === "session/update" && body.params) {
							this.onUpdate(body.params as SessionNotification);
						} else if (body.method === LIFECYCLE_EVENT_METHOD && body.params && this.onLifecycleEvent) {
							this.onLifecycleEvent(body.params as BodhiPiEvent);
						}
					} catch {
						// malformed notification body — skip
					}
					continue;
				}
				// Skip page-side synthetic frames (slash router emits responses
				// with data-frame-method="_test/..."). Real ACP JSON-RPC
				// responses carry no method field — those are ours to consume.
				if (f.kind === "response" && f.method.startsWith("_test/")) {
					continue;
				}
				if (f.kind === "response") {
					this.lastFrameSeq = cursor;
					try {
						const body = JSON.parse(f.payload) as {
							result?: unknown;
							error?: { code: number; message: string; data?: unknown };
						};
						if (body.error) {
							throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
						}
						return body.result;
					} catch (err) {
						if (err instanceof Error && err.message.startsWith("RPC error")) throw err;
						throw new Error(`browser-connection: failed to parse response frame: ${(err as Error).message}`);
					}
				}
			}
			this.lastFrameSeq = cursor;
			await this.page.waitForTimeout(25);
		}
		throw new Error(`browser-connection: timed out waiting for response to ${opts.method}`);
	}
}
