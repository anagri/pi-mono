export interface ChatToolCall {
	id: string;
	name: string;
	status: "running" | "completed" | "failed";
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system";
	text: string;
	toolCalls: ChatToolCall[];
	dataAttrs?: Record<string, string>;
}

export type ChatPanelState = "idle" | "streaming";

export interface ChatPanelProps {
	state: ChatPanelState;
	currentModel: string;
	sessionId: string;
	messages: ChatMessage[];
	composerValue: string;
	onComposerChange(v: string): void;
	onSend(): void;
	onStop(): void;
}

export function ChatPanel({
	state,
	currentModel,
	sessionId,
	messages,
	composerValue,
	onComposerChange,
	onSend,
	onStop,
}: ChatPanelProps) {
	const streaming = state === "streaming";
	return (
		<section
			className="chat-panel"
			data-testid="chat-panel"
			data-test-state={state}
			data-current-model={currentModel}
			data-session-id={sessionId}
		>
			<div className="chat-messages" data-testid="chat-messages">
				{messages.map((m, idx) => {
					const isLastAssistant = m.role === "assistant" && idx === messages.length - 1;
					const messageState = isLastAssistant && streaming ? "streaming" : "done";
					return (
						<div
							key={m.id}
							className="chat-message"
							data-testid="chat-message"
							data-message-role={m.role}
							data-test-state={messageState}
							{...(m.dataAttrs ?? {})}
						>
							<span className="chat-message-role">{m.role}</span>
							{m.text && <pre>{m.text}</pre>}
							{m.toolCalls.map((tc) => (
								<div
									key={tc.id}
									className="tool-call"
									data-testid="tool-call"
									data-tool-name={tc.name}
									data-tool-status={tc.status}
								>
									{tc.name} [{tc.status}]
								</div>
							))}
						</div>
					);
				})}
			</div>
			<div className="composer" data-testid="composer">
				<textarea
					data-testid="composer-input"
					value={composerValue}
					onChange={(e) => onComposerChange(e.target.value)}
					rows={3}
					disabled={streaming}
				/>
				{streaming ? (
					<button data-testid="composer-send" data-mode="stop" type="button" onClick={onStop}>
						stop
					</button>
				) : (
					<button data-testid="composer-send" data-mode="send" type="button" onClick={onSend}>
						send
					</button>
				)}
			</div>
		</section>
	);
}
