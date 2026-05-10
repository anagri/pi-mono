import { useChatStore } from "../store/chatStore";
import { useRuntime } from "./RuntimeProvider";

export function StatusBar() {
	const { currentModelId, sessionId, status, mountPath } = useChatStore();
	const { unmount } = useRuntime();
	const sessionDisplay = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;

	async function handleUnmount() {
		const ok = window.confirm(
			"Forget the granted folder and return to the picker?\n\n" +
				"Your sessions stay in IndexedDB but will be hidden until you re-grant the same folder.",
		);
		if (!ok) return;
		await unmount();
	}

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
			{mountPath ? (
				<button
					type="button"
					data-testid="status-unmount"
					className="status-bar-unmount"
					onClick={handleUnmount}
					title="Forget this folder and return to the picker"
				>
					Unmount
				</button>
			) : null}
		</div>
	);
}
