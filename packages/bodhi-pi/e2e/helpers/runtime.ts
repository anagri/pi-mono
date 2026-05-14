export type E2ERuntime = "in-memory" | "cli" | "http" | "ws" | "browser" | "chrome-ext";

interface RuntimeGlobals {
	__bodhiPiRuntime?: E2ERuntime;
}

const runtimeGlobals = globalThis as unknown as RuntimeGlobals;

export function setRuntime(r: E2ERuntime): void {
	const existing = runtimeGlobals.__bodhiPiRuntime;
	if (existing !== undefined && existing !== r) {
		throw new Error(
			`E2E runtime sentinel already set to '${existing}', cannot reset to '${r}'. ` +
				`Check that vitest projects don't share a setup file.`,
		);
	}
	runtimeGlobals.__bodhiPiRuntime = r;
}

export function getRuntime(): E2ERuntime {
	const r = runtimeGlobals.__bodhiPiRuntime;
	if (!r) {
		throw new Error(
			"E2E runtime sentinel not set. The vitest project's setupFile must set globalThis.__bodhiPiRuntime.",
		);
	}
	return r;
}

export function isRuntime(r: E2ERuntime): boolean {
	return runtimeGlobals.__bodhiPiRuntime === r;
}
