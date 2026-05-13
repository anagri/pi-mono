// adapted from packages/bodhi-pi-browser/src/runtime/types.ts —
// drops sandboxPort + workspace provider (main thread mounts ZenFS directly
// for e2e), adds e2e-specific fields (models / defaultModelId / apiKeys / cwd
// / homeDir) that the e2e harness configures per test.

import type { Api, Model } from "@earendil-works/pi-ai";

export interface InitMessage {
	type: "init";
	agentPort: MessagePort;
	cwd: string;
	dbName: string;
	mountName: string;
	seedFiles: Record<string, string>;
	models?: Model<Api>[];
	defaultModelId?: string;
	apiKeys?: Record<string, string>;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	homeDir?: string;
}

export interface FsQueryMessage {
	type: "bodhi-pi-fs-query";
	id: number;
	op: "read" | "exists";
	path: string;
}

export interface FsReplyMessage {
	type: "bodhi-pi-fs-reply";
	id: number;
	ok: boolean;
	content?: string;
	exists?: boolean;
	error?: string;
}

export interface WorkerEventMessage {
	type: "bodhi-pi-event";
	// Forward the full event record (structured-cloneable JSON) so e2e tests
	// can inspect fields like assistantMessageEvent on MessageUpdateEvent.
	record: Record<string, unknown> & { type: string };
}

export interface WorkerWireMessage {
	type: "bodhi-pi-wire";
	direction: "in" | "out";
	line: string;
	ts: number;
}

export interface WorkerReadyMessage {
	type: "bodhi-pi-ready";
}

export interface WorkerErrorMessage {
	type: "bodhi-pi-error";
	message: string;
}

export type WorkerMessage =
	| WorkerEventMessage
	| WorkerWireMessage
	| WorkerReadyMessage
	| WorkerErrorMessage
	| FsReplyMessage;
