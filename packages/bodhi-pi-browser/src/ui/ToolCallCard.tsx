import type { ToolCallEntry } from "../store/chatStore";

const STATUS_GLYPH: Record<ToolCallEntry["status"], string> = {
	running: "⏳",
	completed: "✓",
	failed: "✗",
};

export function ToolCallCard({ entry }: { entry: ToolCallEntry }) {
	return (
		<div
			data-testid="tool-call"
			data-tool-name={entry.name}
			data-tool-status={entry.status}
			data-tool-call-id={entry.toolCallId}
			className={`tool-call tool-call-${entry.status}`}
		>
			<div className="tool-call-header">
				<span className="tool-call-glyph" aria-hidden="true">
					{STATUS_GLYPH[entry.status]}
				</span>
				<span className="tool-call-name">{entry.name}</span>
				<span className="tool-call-title">{entry.title}</span>
			</div>
			{entry.preview ? <pre className="tool-call-preview">{entry.preview}</pre> : null}
		</div>
	);
}
