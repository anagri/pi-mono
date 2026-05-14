import { parseSeedFiles } from "@e2e/app-utils/browser/lib/seed-parser.ts";
import type {
	ConnectCallbacks,
	ConnectResult,
	SetupFormValues,
	TransportAdapter,
} from "@e2e/app-utils/browser/ui/index.ts";
import { connect, LIFECYCLE_EVENT_METHOD } from "./lib/ws/transport.ts";

interface ProvisionResponse {
	token: string;
	workspaceRoot: string;
	cwd: string;
}

export function createWsAdapter(): TransportAdapter {
	let ws: WebSocket | null = null;
	return {
		async connect(values: SetupFormValues, callbacks: ConnectCallbacks): Promise<ConnectResult> {
			const id = Number(values.userId);
			if (!Number.isFinite(id)) throw new Error("user-id must be numeric for ws transport");
			const files = parseSeedFiles(values.seed);
			const provisionRes = await fetch("/provision", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id, email: values.userEmail, files }),
			});
			if (!provisionRes.ok) {
				const text = await provisionRes.text();
				throw new Error(`provision failed: ${provisionRes.status} ${text}`);
			}
			const { workspaceRoot, cwd } = (await provisionRes.json()) as ProvisionResponse;

			const url = `${window.location.origin.replace(/^http/, "ws")}/acp-ws`;
			const result = await connect({
				url,
				user: { id, email: values.userEmail },
				handlers: {
					onSessionUpdate: (n) => callbacks.onSessionUpdate(n),
					onExtNotification: (method, params) => {
						if (method !== LIFECYCLE_EVENT_METHOD) return;
						const type = typeof params.type === "string" ? params.type : "lifecycle";
						callbacks.onEvent(type, JSON.stringify(params));
					},
				},
				frameTap: (direction, raw) => {
					// ws-stream convention: "in" = browser→agent (our send); "out" = agent→browser (incoming).
					// e2e wire panel convention: "out" = browser→agent; "in" = agent→browser. Invert.
					const normalized: "in" | "out" = direction === "in" ? "out" : "in";
					callbacks.onFrame(parseRawFrame(normalized, raw));
				},
			});
			ws = result.ws;
			return { conn: result.conn as unknown as ConnectResult["conn"], workspaceRoot, cwd };
		},
		cleanup() {
			ws?.close();
			ws = null;
		},
	};
}

function parseRawFrame(direction: "in" | "out", raw: string): Parameters<ConnectCallbacks["onFrame"]>[0] {
	let parsed: { method?: string; id?: string | number; result?: unknown; error?: unknown };
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = {};
	}
	const method = typeof parsed.method === "string" ? parsed.method : "";
	const rpcId = parsed.id !== undefined ? String(parsed.id) : "";
	const isNotification = !!parsed.method && parsed.id === undefined;
	const isResponse = parsed.id !== undefined && (parsed.result !== undefined || parsed.error !== undefined);
	const kind: "request" | "response" | "notification" = isNotification
		? "notification"
		: isResponse
			? "response"
			: "request";
	return { direction, kind, method, rpcId, payload: raw };
}
