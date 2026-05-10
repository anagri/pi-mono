// Vite resolves `new URL("./worker.ts", import.meta.url)` against this host
// source, so the spawn must live in the host package.
export function workerFactory(): Worker {
	return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}
