/** "in" = client → agent (browser → server). "out" = agent → client (server → browser). Matches bodhi-pi-web. */
export type FrameDirection = "in" | "out";

export interface RawFrame {
	direction: FrameDirection;
	raw: string;
	ts: number;
}

const MAX_ENTRIES = 500;

type Subscriber = (entries: ReadonlyArray<RawFrame>) => void;

export interface EventLog {
	publish(entry: RawFrame): void;
	entries(): ReadonlyArray<RawFrame>;
	subscribe(fn: Subscriber): () => void;
	clear(): void;
}

export function createEventLog(): EventLog {
	const buffer: RawFrame[] = [];
	const subscribers = new Set<Subscriber>();

	const notify = () => {
		const snapshot = buffer.slice();
		for (const fn of subscribers) fn(snapshot);
	};

	return {
		publish(entry) {
			buffer.push(entry);
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
