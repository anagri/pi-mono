import type { ExtensionEventBus } from "./types.js";

/** In-memory pub/sub used by `pi.events` for inter-extension communication. */
export function createExtensionEventBus(): ExtensionEventBus {
	const channels = new Map<string, Set<(data: unknown) => void | Promise<void>>>();
	return {
		emit(channel, data) {
			const handlers = channels.get(channel);
			if (!handlers) return;
			for (const h of handlers) {
				// Promise.resolve().then(...) catches both sync and async throws.
				Promise.resolve()
					.then(() => h(data))
					.catch((err) => {
						console.error(`[bodhi-pi pi.events:${channel}] handler threw`, err);
					});
			}
		},
		on(channel, handler) {
			const set = channels.get(channel) ?? new Set();
			set.add(handler);
			channels.set(channel, set);
			return () => {
				set.delete(handler);
				if (set.size === 0) channels.delete(channel);
			};
		},
	};
}
