import { useState } from "react";
import { useChatStore } from "../store/chatStore";

export interface ComposerProps {
	onSubmit: (text: string) => void | Promise<void>;
	disabled?: boolean;
}

export function Composer({ onSubmit, disabled }: ComposerProps) {
	const [value, setValue] = useState("");
	const status = useChatStore((s) => s.status);
	// Composer is hard-disabled only during initial boot. In the "closed" state
	// the user must still be able to type slash commands (/new, /resume, /help)
	// to recover, so we keep the input enabled and rely on the prompt handler
	// to block non-slash content.
	const isDisabled = disabled || status === "initializing";
	const placeholder =
		status === "closed"
			? "session closed — type /new or /resume <id>"
			: status === "initializing"
				? "starting…"
				: "Type a message or /help";

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const text = value.trim();
		if (!text || isDisabled) return;
		setValue("");
		await onSubmit(text);
	}

	return (
		<form data-testid="composer" className="composer" onSubmit={handleSubmit} data-composer-status={status}>
			<input
				data-testid="composer-input"
				className="composer-input"
				type="text"
				value={value}
				disabled={isDisabled}
				onChange={(e) => setValue(e.target.value)}
				placeholder={placeholder}
				autoFocus
			/>
			<button data-testid="composer-send" type="submit" className="composer-send" disabled={isDisabled}>
				Send
			</button>
		</form>
	);
}
