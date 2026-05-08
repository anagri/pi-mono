import { useChatStore } from "../store/chatStore";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { StatusBar } from "./StatusBar";

export function ChatPage() {
	const { status, addMessage } = useChatStore();

	// M2 echo-only behavior. M3 replaces this with conn.prompt(...) via RuntimeProvider.
	async function handleSubmit(text: string) {
		addMessage("user", text);
		addMessage("assistant", `echo: ${text}`);
	}

	return (
		<div data-testid="chat-page" data-test-state={status} className="chat-page">
			<StatusBar />
			<MessageList />
			<Composer onSubmit={handleSubmit} />
		</div>
	);
}
