import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";

export type BatchChildStatus = "queued" | "running" | "completed" | "cancelled" | "failed";

export interface BatchProgressChildEntry {
	childSessionId: string;
	profile: string;
	toolCount: number;
	status: BatchChildStatus;
	lastTool?: string;
}

export interface BatchProgressDetails {
	kind: "subagent_batch_progress";
	batchToolCallId: string;
	children: BatchProgressChildEntry[];
}

export class BatchProgressAccumulator {
	private readonly batchToolCallId: string;
	private readonly onUpdate: AgentToolUpdateCallback;
	private readonly order: string[] = [];
	private readonly entries = new Map<string, BatchProgressChildEntry>();

	constructor(args: {
		batchToolCallId: string;
		onUpdate: AgentToolUpdateCallback;
		children: Array<{ childSessionId: string; profile: string }>;
	}) {
		this.batchToolCallId = args.batchToolCallId;
		this.onUpdate = args.onUpdate;
		for (const c of args.children) {
			this.order.push(c.childSessionId);
			this.entries.set(c.childSessionId, {
				childSessionId: c.childSessionId,
				profile: c.profile,
				toolCount: 0,
				status: "queued",
			});
		}
	}

	markRunning(childSessionId: string): void {
		const entry = this.entries.get(childSessionId);
		if (!entry || entry.status !== "queued") return;
		entry.status = "running";
		this.emit();
	}

	recordToolStart(childSessionId: string, toolName: string): void {
		const entry = this.entries.get(childSessionId);
		if (!entry) return;
		entry.toolCount += 1;
		entry.lastTool = toolName;
		if (entry.status === "queued") entry.status = "running";
		this.emit();
	}

	recordChildEnd(childSessionId: string, status: "completed" | "cancelled" | "failed"): void {
		const entry = this.entries.get(childSessionId);
		if (!entry) return;
		entry.status = status;
		this.emit();
	}

	private emit(): void {
		const children = this.order.map((id) => {
			const e = this.entries.get(id)!;
			const out: BatchProgressChildEntry = {
				childSessionId: e.childSessionId,
				profile: e.profile,
				toolCount: e.toolCount,
				status: e.status,
			};
			if (e.lastTool !== undefined) out.lastTool = e.lastTool;
			return out;
		});
		const summary = children
			.map((c) => `${c.profile}:${c.status}${c.lastTool ? ` (${c.lastTool}#${c.toolCount})` : ""}`)
			.join(", ");
		this.onUpdate({
			content: [{ type: "text", text: `batch[${summary}]` }],
			details: {
				kind: "subagent_batch_progress",
				batchToolCallId: this.batchToolCallId,
				children,
			} satisfies BatchProgressDetails,
		});
	}
}
