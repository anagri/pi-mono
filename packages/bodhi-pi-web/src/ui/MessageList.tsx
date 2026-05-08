import { useChatStore } from "../store/chatStore";

export function MessageList() {
	const messages = useChatStore((s) => s.messages);
	return (
		<div data-testid="message-list" className="message-list">
			{messages.map((m) => (
				<div
					key={m.id}
					data-testid="message"
					data-message-role={m.role}
					className={`message message-${m.role}`}
				>
					<span className="message-role">{m.role}</span>
					<span className="message-content">{m.content}</span>
				</div>
			))}
		</div>
	);
}
