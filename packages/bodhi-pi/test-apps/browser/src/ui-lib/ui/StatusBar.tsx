export interface StatusBarProps {
	title: string;
	model: string;
	sessionId: string;
	state: string;
}

export function StatusBar({ title, model, sessionId, state }: StatusBarProps) {
	const shortSession = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
	return (
		<header
			data-testid="status-bar"
			data-current-model={model}
			data-session-id={sessionId}
			data-test-state={state}
			className="status-bar"
		>
			<span>{title}</span>
			<span>model: {model || "—"}</span>
			<span>session: {shortSession || "—"}</span>
			<span className="status-bar-state">{state}</span>
		</header>
	);
}
