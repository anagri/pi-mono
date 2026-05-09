import { useCallback, useEffect, useState } from "react";
import { connect, type Connection } from "./lib/transport";
import { useSettings } from "./hooks/useSettings";
import { useChat } from "./hooks/useChat";
import { useSessions } from "./hooks/useSessions";
import "./App.css";

type Status = "idle" | "connecting" | "connected" | "disconnected" | "unauthorized";

const SERVER_URL = (import.meta.env.VITE_WS_SERVER_URL as string | undefined) ?? "ws://localhost:8788/agent";

function App() {
	const { settings, update } = useSettings();
	const [status, setStatus] = useState<Status>("idle");
	const [agentName, setAgentName] = useState<string>("");
	const [connectError, setConnectError] = useState<string>("");
	const [connection, setConnection] = useState<Connection | null>(null);
	const [draft, setDraft] = useState<string>("");

	const chat = useChat({ conn: connection?.conn ?? null });
	const sessions = useSessions({ conn: connection?.conn ?? null });

	const onConnect = useCallback(async () => {
		setConnectError("");
		setAgentName("");
		setStatus("connecting");
		try {
			const c = await connect({
				url: SERVER_URL,
				user: settings.sendToken ? { id: settings.id, email: settings.email } : undefined,
				handlers: { onSessionUpdate: chat.handleNotification },
				onClose: () => setStatus("disconnected"),
			});
			setConnection(c);
			const result = await c.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
			setAgentName(result.agentInfo?.name ?? "");
			setStatus("connected");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			setConnectError(msg);
			setStatus(settings.sendToken ? "disconnected" : "unauthorized");
		}
	}, [settings, chat.handleNotification]);

	const onDisconnect = useCallback(() => {
		connection?.ws.close();
		setConnection(null);
		setStatus("disconnected");
		chat.reset();
	}, [connection, chat]);

	const onSend = useCallback(async () => {
		const text = draft.trim();
		if (!text) return;
		setDraft("");
		await chat.send(text);
		void sessions.refresh();
	}, [draft, chat, sessions]);

	const onLoad = useCallback(
		async (sessionId: string) => {
			await chat.loadSession(sessionId);
		},
		[chat],
	);

	const onDelete = useCallback(
		async (sessionId: string) => {
			await sessions.remove(sessionId);
			if (chat.currentSessionId() === sessionId) {
				chat.newSession();
			}
		},
		[chat, sessions],
	);

	const onNewSession = useCallback(() => {
		chat.newSession();
	}, [chat]);

	// Refresh session list whenever we connect.
	useEffect(() => {
		if (status === "connected") {
			void sessions.refresh();
		}
	}, [status, sessions]);

	return (
		<main
			style={{
				maxWidth: 960,
				margin: "2rem auto",
				padding: "0 1rem",
				fontFamily: "system-ui, sans-serif",
			}}
		>
			<h1>bodhi-pi WS frontend</h1>

			<section data-testid="settings" style={{ display: "grid", gap: "0.5rem", marginBottom: "1.5rem" }}>
				<h2 style={{ fontSize: "1rem" }}>Settings</h2>
				<label>
					Email
					<input
						data-testid="settings-email"
						type="email"
						value={settings.email}
						onChange={(e) => update("email", e.target.value)}
						style={{ width: "100%" }}
					/>
				</label>
				<label>
					User id
					<input
						data-testid="settings-id"
						type="number"
						value={settings.id}
						onChange={(e) => update("id", Number(e.target.value))}
						style={{ width: "100%" }}
					/>
				</label>
				<label>
					<input
						data-testid="settings-sendToken"
						type="checkbox"
						checked={settings.sendToken}
						onChange={(e) => update("sendToken", e.target.checked)}
					/>{" "}
					Send token on connect
				</label>
			</section>

			<section style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "1rem" }}>
				<button
					type="button"
					data-testid="connect"
					onClick={onConnect}
					disabled={status === "connecting" || status === "connected"}
				>
					Connect
				</button>
				<button
					type="button"
					data-testid="disconnect"
					onClick={onDisconnect}
					disabled={status !== "connected"}
				>
					Disconnect
				</button>
			</section>

			<section
				data-testid="status"
				data-status={status}
				data-agent-name={agentName}
				data-chat-status={chat.status}
				style={{ padding: "0.75rem", border: "1px solid #ccc", borderRadius: 4, marginBottom: "1rem" }}
			>
				<div>
					Status: <strong data-testid="status-text">{status}</strong>
					{chat.status === "streaming" ? <span> · streaming</span> : null}
				</div>
				{agentName ? (
					<div>
						Agent: <span data-testid="agent-name">{agentName}</span>
					</div>
				) : null}
				{connectError ? (
					<div data-testid="error" style={{ color: "crimson", marginTop: "0.5rem" }}>
						{connectError}
					</div>
				) : null}
			</section>

			{status === "connected" ? (
				<div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: "1rem" }}>
					<aside
						data-testid="session-list"
						style={{
							border: "1px solid #ccc",
							borderRadius: 4,
							padding: "0.5rem",
						}}
					>
						<div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
							<strong>Sessions</strong>
							<button type="button" data-testid="new-session" onClick={onNewSession}>
								+ New
							</button>
						</div>
						{sessions.rows.length === 0 ? (
							<div style={{ color: "#888", fontSize: "0.9rem" }}>No sessions yet.</div>
						) : null}
						<ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
							{sessions.rows.map((row) => (
								<li
									key={row.sessionId}
									data-testid="session-row"
									data-session-id={row.sessionId}
									style={{
										padding: "0.4rem 0.25rem",
										borderTop: "1px solid #eee",
										display: "flex",
										gap: "0.25rem",
										alignItems: "center",
										fontSize: "0.85rem",
									}}
								>
									<button
										type="button"
										data-testid="session-load"
										onClick={() => void onLoad(row.sessionId)}
										style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis" }}
										title={row.sessionId}
									>
										{row.sessionId.slice(0, 8)} · {row.messageCount} msg
									</button>
									<button
										type="button"
										data-testid="session-delete"
										onClick={() => void onDelete(row.sessionId)}
										aria-label="delete session"
									>
										✕
									</button>
								</li>
							))}
						</ul>
					</aside>

					<div>
						<section
							data-testid="messages"
							style={{
								border: "1px solid #ccc",
								borderRadius: 4,
								padding: "0.75rem",
								minHeight: 200,
								marginBottom: "1rem",
								display: "flex",
								flexDirection: "column",
								gap: "0.5rem",
							}}
						>
							{chat.items.length === 0 ? (
								<div style={{ color: "#888" }}>No messages yet.</div>
							) : null}
							{chat.items.map((it, idx) => {
								if (it.kind === "message") {
									return (
										<div
											key={`${idx}-${it.role}`}
											data-testid="message"
											data-role={it.role}
											style={{
												padding: "0.5rem",
												borderRadius: 4,
												background: it.role === "user" ? "#eef" : "#efe",
												whiteSpace: "pre-wrap",
											}}
										>
											<strong>{it.role}:</strong> {it.text}
										</div>
									);
								}
								return (
									<div
										key={`${idx}-${it.toolCallId}`}
										data-testid="tool-call"
										data-tool-name={it.name}
										data-tool-status={it.status}
										data-tool-call-id={it.toolCallId}
										style={{
											padding: "0.5rem",
											borderRadius: 4,
											background: "#fff5d6",
											fontFamily: "ui-monospace, monospace",
											fontSize: "0.9rem",
										}}
									>
										<strong>tool · {it.name}</strong> [{it.status}] · {it.title}
									</div>
								);
							})}
							{chat.error ? (
								<div data-testid="chat-error" style={{ color: "crimson" }}>
									{chat.error}
								</div>
							) : null}
						</section>
						<section style={{ display: "flex", gap: "0.5rem" }}>
							<textarea
								data-testid="composer"
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										void onSend();
									}
								}}
								rows={2}
								style={{ flex: 1, padding: "0.5rem", font: "inherit" }}
								disabled={chat.status === "streaming"}
								placeholder="Type a message; press Enter to send"
							/>
							<button
								type="button"
								data-testid="send"
								onClick={onSend}
								disabled={chat.status === "streaming" || !draft.trim()}
							>
								Send
							</button>
						</section>
					</div>
				</div>
			) : null}
		</main>
	);
}

export default App;
