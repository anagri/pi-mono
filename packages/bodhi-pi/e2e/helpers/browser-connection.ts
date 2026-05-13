/// <reference lib="dom" />
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

interface FrameSnapshot {
	seq: number;
	direction: "out" | "in";
	kind: "request" | "response" | "notification";
	method: string;
	rpcId: string;
	payload: string;
}

interface EventSnapshot {
	seq: number;
	type: string;
	payload: string;
}

const LIFECYCLE_EVENT_METHOD = "_bodhi-pi/lifecycle/event";

let nextId = 1;

export class BrowserAcpConnection implements BodhiPiAcpConnection {
	private readonly page: Page;
	private readonly onUpdate: (notif: SessionNotification) => void;
	private readonly onLifecycleEvent: ((ev: BodhiPiEvent) => void) | undefined;
	private lastFrameSeq = 0;
	private lastEventSeq = 0;

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
	async cancel(_params: { sessionId: string }): Promise<void> {
		// Page tracks the active sessionId from the most recent
		// new/load/resume response and fires session/cancel on click. We
		// ignore the params.sessionId argument and trust the page's tracker.
		// The harness sees the cancel frame in the same DOM frame log.
		await this.page.click('[data-testid="acp-cancel"]');
	}
	extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.call(method, params) as Promise<Record<string, unknown>>;
	}

	private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
		// id in the body is informational only: the in-page SDK rewrites it.
		// Correlation is by ordering — requests are sequential through this
		// connection, so the next response frame after submit IS this call's.
		const id = nextId++;
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
			const { frames, events } = await this.readNewFrames(cursor);
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

	private async readNewFrames(cursor: number): Promise<{ frames: FrameSnapshot[]; events: EventSnapshot[] }> {
		// Bulk DOM read over the documented contract (data-testid +
		// data-frame-*/data-event-*). Not a peek at internal state — the same
		// data is exposed via Playwright locators; the bulk read avoids
		// per-element round-trips that would make streaming-poll loops slow.
		const data = await this.page.evaluate(
			({ frameCursor, eventCursor }) => {
				const frames: FrameSnapshot[] = [];
				const events: EventSnapshot[] = [];
				const frameLog = document.querySelector('[data-testid="frame-log"]');
				if (frameLog) {
					for (const el of Array.from(frameLog.querySelectorAll<HTMLElement>('[data-testid="frame"]'))) {
						const seq = Number(el.dataset.frameSeq ?? 0);
						if (seq <= frameCursor) continue;
						const pre = el.querySelector("pre");
						frames.push({
							seq,
							direction: (el.dataset.frameDirection ?? "") as FrameSnapshot["direction"],
							kind: (el.dataset.frameKind ?? "") as FrameSnapshot["kind"],
							method: el.dataset.frameMethod ?? "",
							rpcId: el.dataset.frameRpcId ?? "",
							payload: pre?.textContent ?? "",
						});
					}
				}
				const eventLog = document.querySelector('[data-testid="event-log"]');
				if (eventLog) {
					for (const el of Array.from(eventLog.querySelectorAll<HTMLElement>('[data-testid="event"]'))) {
						const seq = Number(el.dataset.eventSeq ?? 0);
						if (seq <= eventCursor) continue;
						const pre = el.querySelector("pre");
						events.push({
							seq,
							type: el.dataset.eventType ?? "",
							payload: pre?.textContent ?? "",
						});
					}
				}
				return { frames, events };
			},
			{ frameCursor: cursor, eventCursor: this.lastEventSeq },
		);
		data.frames.sort((a, b) => a.seq - b.seq);
		data.events.sort((a, b) => a.seq - b.seq);
		if (data.events.length > 0) this.lastEventSeq = data.events[data.events.length - 1].seq;
		return data;
	}
}
