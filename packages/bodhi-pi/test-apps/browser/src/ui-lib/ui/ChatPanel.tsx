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
			data-testid="chat-panel"
			data-test-state={state}
			data-current-model={currentModel}
			data-session-id={sessionId}
		>
			<div data-testid="chat-messages">
				{messages.map((m, idx) => {
					const isLastAssistant = m.role === "assistant" && idx === messages.length - 1;
					const messageState = isLastAssistant && streaming ? "streaming" : "done";
					return (
						<div
							key={m.id}
							data-testid="chat-message"
							data-message-role={m.role}
							data-test-state={messageState}
							{...(m.dataAttrs ?? {})}
						>
							{m.text && <pre>{m.text}</pre>}
						{m.toolCalls.map((tc) => (
								<div
									key={tc.id}
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
			<div data-testid="composer">
				<textarea
					data-testid="composer-input"
					value={composerValue}
					onChange={(e) => onComposerChange(e.target.value)}
					rows={3}
					cols={60}
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
