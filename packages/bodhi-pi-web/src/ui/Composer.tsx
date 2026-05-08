import { useState } from "react";
import { useChatStore } from "../store/chatStore";

export interface ComposerProps {
	onSubmit: (text: string) => void | Promise<void>;
	disabled?: boolean;
}

export function Composer({ onSubmit, disabled }: ComposerProps) {
	const [value, setValue] = useState("");
	const status = useChatStore((s) => s.status);
	const isDisabled = disabled || status === "closed" || status === "initializing";

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const text = value.trim();
		if (!text || isDisabled) return;
		setValue("");
		await onSubmit(text);
	}

	return (
		<form data-testid="composer" className="composer" onSubmit={handleSubmit}>
			<input
				data-testid="composer-input"
				className="composer-input"
				type="text"
				value={value}
				disabled={isDisabled}
				onChange={(e) => setValue(e.target.value)}
				placeholder={isDisabled ? "(disabled)" : "Type a message or /help"}
				autoFocus
			/>
			<button data-testid="composer-send" type="submit" className="composer-send" disabled={isDisabled}>
				Send
			</button>
		</form>
	);
}
