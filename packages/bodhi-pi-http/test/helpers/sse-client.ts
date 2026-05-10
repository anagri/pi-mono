/**
 * Test-side SSE client. POSTs an ACP JSON-RPC request to /acp and parses the
 * `text/event-stream` response into a sequence of JSON-RPC frames.
 */
export interface SsePromptResult {
	notifications: Array<{ method: string; params: unknown }>;
	final: { id: number | string | null; result?: unknown; error?: { code: number; message: string } };
}

export async function ssePrompt(
	url: string,
	token: string,
	call: { method: string; params: Record<string, unknown>; id?: number | string },
	opts: { signal?: AbortSignal } = {},
): Promise<SsePromptResult> {
	const id = call.id ?? Math.floor(Math.random() * 1_000_000);
	const fetchOpts: RequestInit = {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
			accept: "text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id, method: call.method, params: call.params }),
	};
	if (opts.signal) fetchOpts.signal = opts.signal;
	const res = await fetch(`${url}/acp`, fetchOpts);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
	}
	if (!res.body) throw new Error("response has no body");

	const notifications: Array<{ method: string; params: unknown }> = [];
	let final: SsePromptResult["final"] | undefined;

	const decoder = new TextDecoder();
	const reader = res.body.getReader();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		// Each event ends with \n\n. Process complete events.
		while (true) {
			const idx = buffer.indexOf("\n\n");
			if (idx === -1) break;
			const block = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			const dataLines = block
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trimStart());
			if (dataLines.length === 0) continue;
			const json = dataLines.join("\n");
			const frame = JSON.parse(json) as {
				jsonrpc: string;
				id?: number | string | null;
				method?: string;
				params?: unknown;
				result?: unknown;
				error?: { code: number; message: string };
			};
			if (frame.method !== undefined) {
				notifications.push({ method: frame.method, params: frame.params });
			} else if ("id" in frame) {
				final = {
					id: frame.id ?? null,
					...(frame.result !== undefined ? { result: frame.result } : {}),
					...(frame.error !== undefined ? { error: frame.error } : {}),
				};
			}
		}
	}
	if (!final) throw new Error("SSE stream ended without a final response frame");
	return { notifications, final };
}
