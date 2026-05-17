/**
 * Process-local registry of in-flight prompt turns.
 *
 * `register(sessionId)` returns a fresh `AbortController` and stores it under
 * the sessionId. If a turn is already in flight for that session, it is
 * aborted before the new one is registered (defensive — the agent itself
 * also rejects concurrent turns per ACP, but we don't want stale controllers).
 *
 * `abort(sessionId)` is the entry point for `session/cancel` and `res.on("close")`.
 *
 * `release(sessionId)` removes the entry without aborting. Called by the prompt
 * handler when the turn completes naturally so cancel after that becomes a no-op.
 *
 * Single-node by design — see plan doc.
 */
export interface InflightRegistry {
	register(sessionId: string): AbortController;
	abort(sessionId: string): void;
	release(sessionId: string): void;
}

export function createInflightRegistry(): InflightRegistry {
	const inflight = new Map<string, AbortController>();
	return {
		register(sessionId) {
			const existing = inflight.get(sessionId);
			if (existing) existing.abort("superseded");
			const ctrl = new AbortController();
			inflight.set(sessionId, ctrl);
			return ctrl;
		},
		abort(sessionId) {
			const ctrl = inflight.get(sessionId);
			if (!ctrl) return;
			ctrl.abort("cancelled");
			inflight.delete(sessionId);
		},
		release(sessionId) {
			inflight.delete(sessionId);
		},
	};
}
