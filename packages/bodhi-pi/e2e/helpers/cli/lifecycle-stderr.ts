import readline from "node:readline";
import type { Readable } from "node:stream";
import type { BodhiPiEvent } from "@/index.js";

const LIFECYCLE_EVENT_METHOD = "_bodhi-pi/lifecycle/event";

/**
 * Parse one ndjson stderr line from a cli child spawned with `--rpc`. Returns
 * the lifecycle event payload when the line is a JSON-RPC notification with
 * method `_bodhi-pi/lifecycle/event`; returns null otherwise so the caller can
 * forward the line to its own stderr.
 */
export function parseLifecycleStderrLine(line: string): BodhiPiEvent | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) return null;
	try {
		const frame = JSON.parse(trimmed) as { method?: string; params?: unknown };
		if (frame.method === LIFECYCLE_EVENT_METHOD && frame.params && typeof frame.params === "object") {
			return frame.params as BodhiPiEvent;
		}
	} catch {
		// Not a JSON-RPC frame — caller forwards it verbatim.
	}
	return null;
}

/**
 * Read child stderr line-by-line: lifecycle frames go into `events`,
 * everything else is forwarded to `process.stderr` so genuine diagnostics
 * still surface in the test runner. Returns the readline interface so the
 * caller can `close()` it during cleanup.
 */
export function pipeLifecycleEvents(stderr: Readable, events: BodhiPiEvent[]): readline.Interface {
	const reader = readline.createInterface({ input: stderr });
	reader.on("line", (line) => {
		const event = parseLifecycleStderrLine(line);
		if (event) {
			events.push(event);
			return;
		}
		if (line.trim().length > 0) process.stderr.write(`${line}\n`);
	});
	return reader;
}
