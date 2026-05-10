import { useEffect, useState } from "react";
import type { AcpHttpClient } from "../lib/acp-http-client.ts";
import { useChat } from "../hooks/useChat.ts";

export function Chat(props: { client: AcpHttpClient; sessionId: string }) {
	const chat = useChat(props.client, props.sessionId);
	const [draft, setDraft] = useState("");

	// On session change, replay history.
	useEffect(() => {
		if (!props.sessionId) return;
		void chat.loadSession(props.sessionId);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.sessionId]);

	function submit(e: React.FormEvent) {
		e.preventDefault();
		const text = draft.trim();
		if (!text) return;
		setDraft("");
		void chat.send(text);
	}

	return (
		<section style={{ display: "grid", gap: "0.75rem" }}>
			<div
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
					<div style={{ opacity: 0.5 }}>No messages yet. Type a prompt below.</div>
				) : (
					chat.items.map((it, i) =>
						it.type === "message" ? (
							<div key={`m-${i}`}>
								<strong style={{ opacity: 0.7 }}>{it.message.role === "user" ? "you" : "agent"}:</strong>{" "}
								<span style={{ whiteSpace: "pre-wrap" }}>{it.message.text}</span>
							</div>
						) : (
							<div key={`t-${i}`} style={{ opacity: 0.8, fontStyle: "italic", fontSize: "0.9em" }}>
								<span>tool:</span> {it.tool.name} · {it.tool.status}
							</div>
						),
					)
				)}
			</div>
			{chat.error ? <div style={{ color: "#c0392b" }}>{chat.error}</div> : null}
			<form onSubmit={submit} style={{ display: "flex", gap: "0.5rem" }}>
				<input
					type="text"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="Type a prompt"
					style={{ flex: 1 }}
					disabled={chat.status === "streaming"}
				/>
				{chat.status === "streaming" ? (
					<button type="button" onClick={chat.cancel}>
						Stop
					</button>
				) : (
					<button type="submit">Send</button>
				)}
			</form>
		</section>
	);
}
