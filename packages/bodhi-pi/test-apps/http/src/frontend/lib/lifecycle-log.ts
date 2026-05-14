export interface LifecycleEventRow {
	id: number;
	type: string;
	sessionId?: string;
	toolName?: string;
	userPrompt?: string;
	stopReason?: string;
	fromModelId?: string;
	toModelId?: string;
}

const MAX_ENTRIES = 500;

type Subscriber = (entries: ReadonlyArray<LifecycleEventRow>) => void;

export interface LifecycleLog {
	publish(row: Omit<LifecycleEventRow, "id">): void;
	entries(): ReadonlyArray<LifecycleEventRow>;
	subscribe(fn: Subscriber): () => void;
	clear(): void;
}

export function createLifecycleLog(): LifecycleLog {
	const buffer: LifecycleEventRow[] = [];
	const subscribers = new Set<Subscriber>();
	let nextId = 0;

	const notify = () => {
		const snapshot = buffer.slice();
		for (const fn of subscribers) fn(snapshot);
	};

	return {
		publish(row) {
			buffer.push({ ...row, id: ++nextId });
			if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
			notify();
		},
		entries() {
			return buffer.slice();
		},
		subscribe(fn) {
			subscribers.add(fn);
			fn(buffer.slice());
			return () => {
				subscribers.delete(fn);
			};
		},
		clear() {
			buffer.length = 0;
			notify();
		},
	};
}

export function lifecycleRowFromParams(params: Record<string, unknown>): Omit<LifecycleEventRow, "id"> | null {
	const type = typeof params.type === "string" ? params.type : "";
	if (!type) return null;
	const row: Omit<LifecycleEventRow, "id"> = { type };
	if (typeof params.sessionId === "string") row.sessionId = params.sessionId;
	if (typeof params.toolName === "string") row.toolName = params.toolName;
	if (typeof params.userPrompt === "string") row.userPrompt = params.userPrompt;
	if (typeof params.stopReason === "string") row.stopReason = params.stopReason;
	if (typeof params.fromModelId === "string") row.fromModelId = params.fromModelId;
	if (typeof params.toModelId === "string") row.toModelId = params.toModelId;
	return row;
}
