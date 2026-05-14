import type { ChildProcess } from "node:child_process";

// Resolves when the spawned `vite preview` (or `vite dev`) prints either
// `ready in NNN ms` (dev) or `Local: http://localhost:<port>/` (preview).
// Strips ANSI sequences from Vite's coloured banner so the readiness regex
// isn't broken by the colour codes.

export async function waitForViteReady(child: ChildProcess, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => reject(new Error(`vite did not become ready within ${timeoutMs}ms`)), timeoutMs);
		const onData = (chunk: Buffer | string) => {
			buf += chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
			if (buf.match(/ready in/i) || buf.match(/Local:\s*http:\/\/localhost:/)) {
				clearTimeout(timer);
				child.stdout?.off("data", onData);
				resolve();
			}
		};
		child.stdout?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`vite exited before becoming ready (code=${code})`));
		});
	});
}
