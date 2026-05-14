import { parseSeedFiles } from "@e2e/app-utils/browser/lib/seed-parser.ts";
import type {
	ConnectCallbacks,
	ConnectResult,
	SetupFormValues,
	TransportAdapter,
} from "@e2e/app-utils/browser/ui/index.ts";
import { AcpHttpClient } from "./lib/acp-http-client.ts";
import { createEventLog } from "./lib/event-log.ts";

interface ProvisionResponse {
	token: string;
	workspaceRoot: string;
	cwd: string;
}

export function createHttpAdapter(): TransportAdapter {
	return {
		async connect(values: SetupFormValues, callbacks: ConnectCallbacks): Promise<ConnectResult> {
			const id = Number(values.userId);
			if (!Number.isFinite(id)) throw new Error("user-id must be numeric for http transport");
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
			const { token, workspaceRoot, cwd } = (await provisionRes.json()) as ProvisionResponse;

			const eventLog = createEventLog();
			const origPublish = eventLog.publish.bind(eventLog);
			eventLog.publish = (entry) => {
				origPublish(entry);
				callbacks.onFrame(parseRawFrame(entry.direction, entry.raw));
			};

			const client = new AcpHttpClient({ token, eventLog });
			client.onSessionUpdate((n) => {
				callbacks.onSessionUpdate(n as Parameters<ConnectCallbacks["onSessionUpdate"]>[0]);
			});
			client.onLifecycleEvent((params) => {
				const type = typeof params.type === "string" ? params.type : "lifecycle";
				callbacks.onEvent(type, JSON.stringify(params));
			});

			const conn = wrapHttpClient(client);
			return { conn: conn as unknown as ConnectResult["conn"], workspaceRoot, cwd };
		},
		cleanup() {
			// AcpHttpClient is stateless beyond in-flight fetch handles; nothing to release.
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

function wrapHttpClient(http: AcpHttpClient) {
	return {
		initialize: (p: Record<string, unknown>) => http.initialize(p),
		newSession: (p: Record<string, unknown>) =>
			http.newSession({
				cwd: typeof p.cwd === "string" ? p.cwd : undefined,
				mcpServers: Array.isArray(p.mcpServers) ? (p.mcpServers as unknown[]) : undefined,
			}),
		loadSession: (p: Record<string, unknown>) =>
			http.loadSession({
				sessionId: String(p.sessionId ?? ""),
				cwd: typeof p.cwd === "string" ? p.cwd : undefined,
				mcpServers: Array.isArray(p.mcpServers) ? (p.mcpServers as unknown[]) : undefined,
			}),
		prompt: (p: Record<string, unknown>) =>
			http.prompt({
				sessionId: String(p.sessionId ?? ""),
				prompt: (p.prompt as Array<{ type: string; text?: string }>) ?? [],
			}),
		listSessions: (p: Record<string, unknown>) => http.listSessions(p),
		closeSession: (p: Record<string, unknown>) => http.closeSession(String(p.sessionId ?? "")),
		cancel: (p: Record<string, unknown>) => http.cancel(String(p.sessionId ?? "")),
		setSessionConfigOption: (p: Record<string, unknown>) =>
			http.setSessionConfigOption({
				sessionId: String(p.sessionId ?? ""),
				configId: String(p.configId ?? ""),
				value: String(p.value ?? ""),
			}),
		extMethod: (m: string, p: Record<string, unknown>) => http.extMethod(m, p),
	};
}
