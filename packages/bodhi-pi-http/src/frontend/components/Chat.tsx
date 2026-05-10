import { useEffect, useRef, useState } from "react";
import { useChat } from "../hooks/useChat.ts";
import type { AcpHttpClient } from "../lib/acp-http-client.ts";
import { handleCommand, isCommand } from "../ui/commands.ts";

export interface ChatProps {
	client: AcpHttpClient;
	sessionId: string | undefined;
	currentModelId: string;
	defaultModelId: string;
	setSessionId: (id: string | undefined) => void;
	setCurrentModelId: (id: string) => void;
	onChatStatusChange?: (status: "idle" | "streaming" | "error") => void;
}

export function Chat(props: ChatProps) {
	const chat = useChat(props.client, props.sessionId);
	const [draft, setDraft] = useState("");
	const lastReportedStatus = useRef<string>("");

	useEffect(() => {
		if (chat.status !== lastReportedStatus.current) {
			lastReportedStatus.current = chat.status;
			props.onChatStatusChange?.(chat.status);
		}
	}, [chat.status, props.onChatStatusChange]);

	// Replay history when the session changes.
	useEffect(() => {
		if (!props.sessionId) return;
		void chat.loadSession(props.sessionId);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.sessionId]);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		const text = draft.trim();
		if (!text) return;
		setDraft("");

		if (isCommand(text)) {
			const handled = await handleCommand(text, {
				client: props.client,
				sessionId: props.sessionId,
				currentModelId: props.currentModelId,
				defaultModelId: props.defaultModelId,
				addSystemMessage: chat.addSystemMessage,
				setCurrentModelId: props.setCurrentModelId,
				setSessionId: props.setSessionId,
				clearMessages: chat.clear,
				loadSession: chat.loadSession,
			});
			if (handled) return;
			// Project command (`/<name>`) — fall through to forward as agent prompt.
		}

		void chat.send(text);
	}

	const streaming = chat.status === "streaming";
	const sessionMissing = !props.sessionId;

	return (
		<section style={{ display: "grid", gap: "0.75rem" }}>
			<div
				data-testid="messages"
				style={{
					minHeight: 240,
					padding: "0.75rem",
					border: "1px solid #ddd",
					borderRadius: 6,
					background: "rgba(0,0,0,0.02)",
					display: "grid",
					gap: "0.5rem",
				}}
			>
				{chat.items.length === 0 ? (
					<div style={{ opacity: 0.5 }}>
						No messages yet. {sessionMissing ? "Use /new to start a session." : "Type a prompt or /help for commands."}
					</div>
				) : (
					chat.items.map((it, i) => {
						if (it.type === "message") {
							return (
								<div key={`m-${i}`} data-testid="message" data-role={it.message.role}>
									<strong>{it.message.role === "user" ? "you" : "agent"}:</strong>{" "}
									<span style={{ whiteSpace: "pre-wrap" }}>{it.message.text}</span>
								</div>
							);
						}
						if (it.type === "system") {
							return (
								<pre
									key={`s-${i}`}
									data-testid="system-message"
									style={{
										margin: 0,
										fontSize: "0.85em",
										opacity: 0.75,
										fontFamily: "ui-monospace, Menlo, monospace",
										whiteSpace: "pre-wrap",
									}}
								>
									{it.system.text}
								</pre>
							);
						}
						return (
							<div
								key={`t-${i}`}
								data-testid="tool-call"
								data-tool-name={it.tool.name}
								data-tool-status={it.tool.status}
								data-tool-call-id={it.tool.id}
								style={{ opacity: 0.85, fontStyle: "italic", fontSize: "0.9em" }}
							>
								<span>tool · </span>
								<strong>{it.tool.name}</strong> · {it.tool.status}
							</div>
						);
					})
				)}
			</div>
			{chat.error ? <div style={{ color: "#c0392b" }}>{chat.error}</div> : null}
			<form onSubmit={submit} style={{ display: "flex", gap: "0.5rem" }}>
				<input
					type="text"
					data-testid="composer"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder={sessionMissing ? "use /new to start a session, /help for commands" : "Type a prompt or slash command"}
					style={{ flex: 1 }}
					disabled={streaming}
				/>
				{streaming ? (
					<button type="button" data-testid="composer-stop" onClick={chat.cancel}>
						Stop
					</button>
				) : (
					<button type="submit" data-testid="send">
						Send
					</button>
				)}
			</form>
		</section>
	);
}
