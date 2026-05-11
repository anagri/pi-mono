// Module-global per-path lock: serialises concurrent writes/edits to the same
// absolute path. Mirrors coding-agent's `file-mutation-queue.ts` but keys on
// the caller-supplied absolute path (no `realpath` resolution — keeps core
// browser-safe; symlinked aliases on Node won't share a lock).
const fileMutationQueues = new Map<string, Promise<void>>();

export async function withFileMutationQueue<T>(absolutePath: string, fn: () => Promise<T>): Promise<T> {
	const key = absolutePath;
	const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
	let releaseNext!: () => void;
	const nextQueue = new Promise<void>((r) => {
		releaseNext = r;
	});
	const chainedQueue = currentQueue.then(() => nextQueue);
	fileMutationQueues.set(key, chainedQueue);
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
