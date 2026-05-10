// The agent worker URL must resolve against host source so Vite can bundle the
// worker chunk. This factory is host-owned for that reason; everything else
// lives in @bodhiapp/bodhi-pi-browser.
export function workerFactory(): Worker {
	return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}
