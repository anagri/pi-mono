import type { ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { Settings } from "../components/Settings.tsx";
import { useSettings } from "../hooks/useSettings.ts";
import { connect, LIFECYCLE_EVENT_METHOD } from "../lib/ws/transport.ts";

type ConnectionStatus = "idle" | "connecting" | "connected" | "error" | "disconnected";
type ChatStatus = "idle" | "streaming";

interface ChatMessage {
	role: "user" | "assistant";
	text: string;
}

interface LifecycleRow {
	type: string;
	sessionId?: string;
	ts: number;
}

/**
 * Manual-smoke chat shell for the /acp-ws transport. Reuses the existing
 * Settings + useSettings panel so the connect controls match the / route.
 * The chat itself is intentionally minimal — full chat parity lives in the
 * Vitest e2e |ws| project, which exercises the same wire under headless ACP
 * round-trips. This page exists so a human (or claude-in-chrome) can verify
 * the transport end-to-end in a browser.
 */
export default function WsApp() {
	const { settings, update } = useSettings();
	const [status, setStatus] = useState<ConnectionStatus>("idle");
	const [chatStatus, setChatStatus] = useState<ChatStatus>("idle");
	const [error, setError] = useState<string | undefined>();
	const [sessionId, setSessionId] = useState<string | undefined>();
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [lifecycle, setLifecycle] = useState<LifecycleRow[]>([]);
	const [composer, setComposer] = useState<string>("");
	const connRef = useRef<ClientSideConnection | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const assistantBufferRef = useRef<string>("");

	const onSessionUpdate = useCallback((n: SessionNotification) => {
		const update = n.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
		if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && update.content.text) {
			assistantBufferRef.current += update.content.text;
			const buffered = assistantBufferRef.current;
			const assistantMsg: ChatMessage = { role: "assistant", text: buffered };
			setMessages((prev) => {
				const last = prev[prev.length - 1];
				if (last && last.role === "assistant") {
					return [...prev.slice(0, -1), assistantMsg];
				}
				return [...prev, assistantMsg];
			});
		}
	}, []);

	const onExtNotification = useCallback((method: string, params: Record<string, unknown>) => {
		if (method !== LIFECYCLE_EVENT_METHOD) return;
		const ev = params as { type?: string; sessionId?: string };
		if (typeof ev.type !== "string") return;
		setLifecycle((prev) =>
			[...prev, { type: ev.type as string, sessionId: ev.sessionId, ts: Date.now() }].slice(-100),
		);
	}, []);

	const doConnect = useCallback(async () => {
		setError(undefined);
		setMessages([]);
		setLifecycle([]);
		setStatus("connecting");
		const url = `${window.location.origin.replace(/^http/, "ws")}/acp-ws`;
		const user = settings.sendToken ? { id: settings.id, email: settings.email } : undefined;
		try {
			const { ws, conn } = await connect({
				url,
				...(user ? { user } : {}),
				handlers: { onSessionUpdate, onExtNotification },
				onClose: () => {
					setStatus("disconnected");
					setChatStatus("idle");
				},
			});
			wsRef.current = ws;
			connRef.current = conn;
			await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
			const session = await conn.newSession({ cwd: "/", mcpServers: [] });
			setSessionId(session.sessionId);
			setStatus("connected");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStatus("error");
		}
	}, [settings.id, settings.email, settings.sendToken, onSessionUpdate, onExtNotification]);

	const doDisconnect = useCallback(() => {
		wsRef.current?.close();
		wsRef.current = null;
		connRef.current = null;
		setStatus("disconnected");
		setChatStatus("idle");
		setSessionId(undefined);
	}, []);

	const sendPrompt = useCallback(async () => {
		const conn = connRef.current;
		if (!conn || !sessionId || composer.trim().length === 0) return;
		const text = composer;
		setComposer("");
		const userMsg: ChatMessage = { role: "user", text };
		setMessages((prev) => [...prev, userMsg]);
		assistantBufferRef.current = "";
		setChatStatus("streaming");
		try {
			await conn.prompt({
				sessionId,
				prompt: [{ type: "text", text }],
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setChatStatus("idle");
		}
	}, [sessionId, composer]);

	useEffect(() => {
		return () => {
			wsRef.current?.close();
		};
	}, []);

	return (
		<main
			data-testid="chat-page"
			data-test-state={status === "connected" ? chatStatus : status}
			style={{ maxWidth: 720, margin: "5vh auto", padding: "0 1rem" }}
		>
			<header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
				<h1 style={{ margin: 0 }}>bodhi-pi-ws (test-app-http /ws/)</h1>
			</header>

			<div style={{ marginTop: "1rem", fontSize: "0.9rem", color: "#666" }} data-testid="status-bar">
				status: {status}
				{chatStatus !== "idle" ? ` (${chatStatus})` : ""}
				{sessionId ? ` · session ${sessionId.slice(0, 8)}…` : ""}
				{error ? ` · ${error}` : ""}
			</div>

			<div style={{ marginTop: "1rem" }}>
				<Settings
					settings={settings}
					update={update}
					onConnect={doConnect}
					onDisconnect={doDisconnect}
					connected={status === "connected"}
				/>
			</div>

			{status === "connected" ? (
				<section style={{ marginTop: "1.5rem" }} data-testid="chat">
					<h2 style={{ margin: "0 0 0.5rem" }}>Chat (WS)</h2>
					<div
						style={{
							border: "1px solid #ccc",
							borderRadius: 4,
							padding: "0.5rem",
							minHeight: 200,
							maxHeight: 360,
							overflowY: "auto",
							marginBottom: "0.5rem",
							background: "#fafafa",
						}}
						data-testid="chat-messages"
					>
						{messages.map((m, i) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: append-only chat list, index is stable
								key={i}
								style={{ marginBottom: "0.5rem" }}
								data-testid={`chat-message-${m.role}`}
							>
								<strong>{m.role}:</strong> {m.text}
							</div>
						))}
					</div>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void sendPrompt();
						}}
						style={{ display: "flex", gap: "0.5rem" }}
					>
						<input
							type="text"
							value={composer}
							onChange={(e) => setComposer(e.target.value)}
							placeholder="say something..."
							style={{ flex: 1, padding: "0.5rem" }}
							data-testid="composer"
							disabled={chatStatus === "streaming"}
						/>
						<button
							type="submit"
							data-testid="send"
							disabled={chatStatus === "streaming" || composer.trim().length === 0}
						>
							{chatStatus === "streaming" ? "..." : "send"}
						</button>
					</form>
				</section>
			) : null}

			<section style={{ marginTop: "1.5rem" }} data-testid="lifecycle-panel">
				<h3 style={{ margin: "0 0 0.5rem" }}>Lifecycle events</h3>
				<div
					style={{
						border: "1px solid #eee",
						borderRadius: 4,
						padding: "0.5rem",
						maxHeight: 200,
						overflowY: "auto",
						fontFamily: "monospace",
						fontSize: "0.8rem",
						background: "#fafafa",
					}}
				>
					{lifecycle.length === 0 ? (
						<em>no events yet</em>
					) : (
						lifecycle.map((row, i) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: append-only event log, index is stable
								key={i}
								data-testid="event-row"
								data-event-type={row.type}
							>
								[{new Date(row.ts).toISOString().slice(11, 19)}] {row.type}
								{row.sessionId ? ` · ${row.sessionId.slice(0, 8)}…` : ""}
							</div>
						))
					)}
				</div>
			</section>
		</main>
	);
}
