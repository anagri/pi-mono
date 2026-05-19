export interface ChatToolCall {
	id: string;
	name: string;
	status: "running" | "completed" | "failed";
}

export interface SubagentGroup {
	childSessionId: string;
	profileName: string;
	status: "running" | "completed" | "cancelled" | "failed";
	messages: ChatMessage[];
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system";
	text: string;
	toolCalls: ChatToolCall[];
	dataAttrs?: Record<string, string>;
	subagentGroup?: SubagentGroup;
}

export type ChatPanelState = "idle" | "streaming";

export interface ChatPanelProps {
	state: ChatPanelState;
	currentModel: string;
	currentMode: string;
	sessionId: string;
	messages: ChatMessage[];
	composerValue: string;
	onComposerChange(v: string): void;
	onSend(): void;
	onStop(): void;
}

import type { ReactElement } from "react";

function renderMessage(m: ChatMessage, idx: number, lastIdx: number, streaming: boolean): ReactElement {
	const isLastAssistant = m.role === "assistant" && idx === lastIdx;
	const messageState = isLastAssistant && streaming ? "streaming" : "done";
	if (m.subagentGroup) {
		const g = m.subagentGroup;
		return (
			<details
				key={m.id}
				className="subagent-group"
				data-testid="subagent-group"
				data-subagent-child-session-id={g.childSessionId}
				data-subagent-name={g.profileName}
				data-subagent-status={g.status}
				open
			>
				<summary className="subagent-group-summary" data-testid="subagent-group-summary">
					sub-agent <strong>{g.profileName}</strong> [{g.status}]
				</summary>
				<div className="subagent-group-body" data-testid="subagent-group-body">
					{g.messages.map((nm, ni) => renderMessage(nm, ni, g.messages.length - 1, streaming))}
				</div>
			</details>
		);
	}
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
}

export function ChatPanel({
	state,
	currentModel,
	currentMode,
	sessionId,
	messages,
	composerValue,
	onComposerChange,
	onSend,
	onStop,
}: ChatPanelProps) {
	const streaming = state === "streaming";
	const lastIdx = messages.length - 1;
	return (
		<section
			className="chat-panel"
			data-testid="chat-panel"
			data-test-state={state}
			data-current-model={currentModel}
			data-current-mode={currentMode}
			data-session-id={sessionId}
		>
			<div className="chat-messages" data-testid="chat-messages">
				{messages.map((m, idx) => renderMessage(m, idx, lastIdx, streaming))}
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
