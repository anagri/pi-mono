// ported from packages/bodhi-pi-chrome-ext/src/agent/sandbox.ts

/**
 * Boots the sandbox iframe and returns a `MessagePort` connected to it.
 * MV3 forbids `unsafe-eval` in extension pages and dedicated workers, but
 * sandboxed pages declared in `manifest.json#sandbox.pages` get a relaxed
 * CSP that allows `Function`, `AsyncFunction`, and `data:` ESM imports.
 */
const SANDBOX_URL = "sandbox.html";

let cached: Promise<MessagePort> | null = null;

export function createSandboxPort(): Promise<MessagePort> {
	if (!cached) cached = bootSandbox();
	return cached;
}

async function bootSandbox(): Promise<MessagePort> {
	const iframe = document.createElement("iframe");
	iframe.src = new URL(SANDBOX_URL, document.baseURI).href;
	iframe.style.display = "none";
	iframe.setAttribute("aria-hidden", "true");
	iframe.title = "bodhi-pi sandbox";

	await new Promise<void>((resolve, reject) => {
		const onReady = (ev: MessageEvent) => {
			const data = ev.data as { type?: string } | undefined;
			if (data?.type !== "bodhi-pi-sandbox-ready") return;
			if (ev.source !== iframe.contentWindow) return;
			window.removeEventListener("message", onReady);
			resolve();
		};
		window.addEventListener("message", onReady);
		iframe.addEventListener("error", () => reject(new Error("sandbox iframe failed to load")), { once: true });
		document.body.appendChild(iframe);
	});

	const channel = new MessageChannel();
	const cw = iframe.contentWindow;
	if (!cw) throw new Error("sandbox iframe has no contentWindow");
	cw.postMessage({ type: "connect", port: channel.port1 }, "*", [channel.port1]);
	return channel.port2;
}
