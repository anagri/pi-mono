import { useChatStore } from "../store/chatStore";

export function StatusBar() {
	const { currentModelId, sessionId, status, mountPath } = useChatStore();
	const sessionDisplay = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
	return (
		<div
			data-testid="status-bar"
			data-current-model={currentModelId}
			data-session-id={sessionDisplay}
			data-mount-path={mountPath}
			className="status-bar"
		>
			<span className="status-bar-model">model: {currentModelId}</span>
			{mountPath ? <span className="status-bar-mount">mount: {mountPath}</span> : null}
			<span className="status-bar-session">session: {sessionDisplay}</span>
			<span className="status-bar-state">{status}</span>
		</div>
	);
}
