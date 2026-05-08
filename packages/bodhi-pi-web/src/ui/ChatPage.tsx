import { useChatStore } from "../store/chatStore";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { useRuntime } from "./RuntimeProvider";
import { StatusBar } from "./StatusBar";

export function ChatPage() {
	const status = useChatStore((s) => s.status);
	const { prompt, cancelPrompt } = useRuntime();

	async function handleSubmit(text: string) {
		await prompt(text);
	}

	async function handleStop() {
		await cancelPrompt();
	}

	return (
		<div data-testid="chat-page" data-test-state={status} className="chat-page">
			<StatusBar />
			<MessageList />
			<Composer onSubmit={handleSubmit} onStop={handleStop} />
		</div>
	);
}
