export type ConnectionStatus = "idle" | "connecting" | "connected" | "unauthorized" | "disconnected" | "error";
export type ChatStatus = "idle" | "streaming" | "error";

export function StatusBar(props: {
	status: ConnectionStatus;
	chatStatus: ChatStatus;
	currentModelId: string;
	sessionId: string | undefined;
	error: string | undefined;
}) {
	return (
		<div
			data-testid="status"
			data-status={props.status}
			data-chat-status={props.chatStatus}
			data-current-model={props.currentModelId}
			data-session-id={props.sessionId ?? ""}
			style={{
				display: "flex",
				gap: "1rem",
				padding: "0.4rem 0.6rem",
				background: "rgba(0,0,0,0.04)",
				borderRadius: 4,
				fontSize: "0.85em",
				flexWrap: "wrap",
			}}
		>
			<span>
				connection: <strong>{props.status}</strong>
			</span>
			<span>
				chat: <strong>{props.chatStatus}</strong>
			</span>
			<span>
				model: <strong>{props.currentModelId || "—"}</strong>
			</span>
			<span>
				session: <strong>{props.sessionId ? props.sessionId.slice(0, 8) : "—"}</strong>
			</span>
			{props.error ? <span style={{ color: "#c0392b" }}>error: {props.error}</span> : null}
		</div>
	);
}
