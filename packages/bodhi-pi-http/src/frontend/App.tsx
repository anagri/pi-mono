import { useCallback, useEffect, useMemo, useState } from "react";
import { Chat } from "./components/Chat.tsx";
import { Settings } from "./components/Settings.tsx";
import { StatusBar, type ConnectionStatus } from "./components/StatusBar.tsx";
import { useSettings } from "./hooks/useSettings.ts";
import { AcpHttpClient } from "./lib/acp-http-client.ts";
import { encodeToken } from "./lib/auth.ts";

type ChatStatus = "idle" | "streaming" | "error";

/**
 * Composite test-state on the chat-root container. Mirrors ws-frontend's rule
 * (`App.tsx:104-108`): connection state takes precedence; once connected, chat
 * status takes over.
 */
function compositeTestState(connection: ConnectionStatus, chat: ChatStatus): string {
	if (connection !== "connected") return connection;
	return chat;
}

export default function App() {
	const { settings, update } = useSettings();
	const [status, setStatus] = useState<ConnectionStatus>("idle");
	const [chatStatus, setChatStatus] = useState<ChatStatus>("idle");
	const [error, setError] = useState<string | undefined>();
	const [sessionId, setSessionId] = useState<string | undefined>();
	const [currentModelId, setCurrentModelId] = useState<string>("");
	const [defaultModelId, setDefaultModelId] = useState<string>("");
	const [client, setClient] = useState<AcpHttpClient | undefined>();

	const connect = useCallback(async () => {
		setError(undefined);
		setStatus("connecting");
		const token = settings.sendToken ? encodeToken({ id: settings.id, email: settings.email }) : "";
		const c = new AcpHttpClient({ token });
		try {
			await c.initialize();
			setClient(c);
			setStatus("connected");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("401")) setStatus("unauthorized");
			else {
				setStatus("error");
				setError(msg);
			}
		}
	}, [settings.id, settings.email, settings.sendToken]);

	const disconnect = useCallback(() => {
		setClient(undefined);
		setSessionId(undefined);
		setCurrentModelId("");
		setStatus("disconnected");
		setChatStatus("idle");
		setError(undefined);
	}, []);

	// On first connect, auto-create a session so the user lands in a usable state
	// without having to type /new. Auto-resume of last session lands in M17.
	useEffect(() => {
		if (status !== "connected" || !client || sessionId !== undefined) return;
		(async () => {
			try {
				const created = await client.newSession({});
				setSessionId(created.sessionId);
				if (!defaultModelId) setDefaultModelId("");
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		})();
	}, [status, client, sessionId, defaultModelId]);

	const testState = useMemo(() => compositeTestState(status, chatStatus), [status, chatStatus]);

	return (
		<main
			data-testid="chat-page"
			data-test-state={testState}
			style={{ maxWidth: 720, margin: "5vh auto", padding: "0 1rem" }}
		>
			<header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
				<h1 style={{ margin: 0 }}>bodhi-pi-http</h1>
			</header>

			<div style={{ marginTop: "1rem" }}>
				<StatusBar
					status={status}
					chatStatus={chatStatus}
					currentModelId={currentModelId}
					sessionId={sessionId}
					error={error}
				/>
			</div>

			<div style={{ marginTop: "1rem" }}>
				<Settings
					settings={settings}
					update={update}
					onConnect={connect}
					onDisconnect={disconnect}
					connected={status === "connected"}
				/>
			</div>

			{client && status === "connected" ? (
				<div style={{ marginTop: "1.5rem" }}>
					<h2 style={{ margin: "0 0 0.5rem" }}>Chat</h2>
					<Chat
						client={client}
						sessionId={sessionId}
						currentModelId={currentModelId}
						defaultModelId={defaultModelId}
						setSessionId={setSessionId}
						setCurrentModelId={setCurrentModelId}
						onChatStatusChange={setChatStatus}
					/>
				</div>
			) : null}
		</main>
	);
}
