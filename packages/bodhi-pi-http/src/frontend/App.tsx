import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chat } from "./components/Chat.tsx";
import { EventsPanel } from "./components/EventsPanel.tsx";
import { Settings } from "./components/Settings.tsx";
import { StatusBar, type ConnectionStatus } from "./components/StatusBar.tsx";
import { useSettings } from "./hooks/useSettings.ts";
import { AcpHttpClient } from "./lib/acp-http-client.ts";
import { encodeToken } from "./lib/auth.ts";
import { createEventLog, type EventLog } from "./lib/event-log.ts";
import * as lastSession from "./lib/last-session.ts";
import { createLifecycleLog, type LifecycleLog, lifecycleRowFromParams } from "./lib/lifecycle-log.ts";

type ChatStatus = "idle" | "streaming" | "error";

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

	// Logs are constructed lazily per connect so disconnecting clears them.
	const [eventLog, setEventLog] = useState<EventLog | null>(null);
	const [lifecycleLog, setLifecycleLog] = useState<LifecycleLog | null>(null);
	const lifecycleUnsubRef = useRef<(() => void) | null>(null);

	const connect = useCallback(async () => {
		setError(undefined);
		setStatus("connecting");
		const token = settings.sendToken ? encodeToken({ id: settings.id, email: settings.email }) : "";
		const newEventLog = createEventLog();
		const newLifecycleLog = createLifecycleLog();
		const c = new AcpHttpClient({ token, eventLog: newEventLog });
		// Subscribe lifecycle dispatch from client → log.
		lifecycleUnsubRef.current?.();
		lifecycleUnsubRef.current = c.onLifecycleEvent((params) => {
			const row = lifecycleRowFromParams(params);
			if (row) newLifecycleLog.publish(row);
		});
		try {
			await c.initialize();
			setEventLog(newEventLog);
			setLifecycleLog(newLifecycleLog);
			setClient(c);
			setStatus("connected");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("401")) setStatus("unauthorized");
			else {
				setStatus("error");
				setError(msg);
			}
			lifecycleUnsubRef.current?.();
			lifecycleUnsubRef.current = null;
		}
	}, [settings.id, settings.email, settings.sendToken]);

	const disconnect = useCallback(() => {
		lifecycleUnsubRef.current?.();
		lifecycleUnsubRef.current = null;
		setClient(undefined);
		setSessionId(undefined);
		setCurrentModelId("");
		setEventLog(null);
		setLifecycleLog(null);
		setStatus("disconnected");
		setChatStatus("idle");
		setError(undefined);
	}, []);

	// On first connect: try to resume last session (M17). If none / fails / cross-tenant,
	// create a fresh session. The session's configOptions return the active model id —
	// we mirror it into currentModelId + defaultModelId so the StatusBar reflects the
	// truth without a separate /model query.
	useEffect(() => {
		if (status !== "connected" || !client || sessionId !== undefined) return;
		(async () => {
			const adoptModelFromConfig = (
				configOptions?: { id: string; currentValue: string }[],
			) => {
				const m = configOptions?.find((c) => c.id === "model");
				if (m) {
					setCurrentModelId(m.currentValue);
					setDefaultModelId((prev) => prev || m.currentValue);
				}
			};
			const last = lastSession.read(settings.id);
			if (last) {
				try {
					const loaded = await client.loadSession({ sessionId: last });
					setSessionId(last);
					adoptModelFromConfig(loaded.configOptions);
					return;
				} catch {
					lastSession.clear(settings.id);
					// fall through to new session
				}
			}
			try {
				const created = await client.newSession({});
				setSessionId(created.sessionId);
				lastSession.write(settings.id, created.sessionId);
				adoptModelFromConfig(created.configOptions);
				// availableCommands captured server-side during the JSON newSession
				// call (no SSE channel); replay through the notification dispatcher
				// so useChat picks them up.
				if (created.availableCommands && created.availableCommands.length > 0) {
					client.dispatchNotificationForReplay("session/update", {
						sessionId: created.sessionId,
						update: { sessionUpdate: "available_commands_update", availableCommands: created.availableCommands },
					});
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		})();
	}, [status, client, sessionId, defaultModelId, settings.id]);

	// Persist active sessionId for auto-resume.
	useEffect(() => {
		if (status === "connected" && sessionId) {
			lastSession.write(settings.id, sessionId);
		}
	}, [status, sessionId, settings.id]);

	const testState = useMemo(() => compositeTestState(status, chatStatus), [status, chatStatus]);

	return (
		<main
			data-testid="chat-page"
			data-test-state={testState}
			style={{
				maxWidth: 720,
				margin: "5vh auto",
				padding: "0 1rem",
				// Reserve right-side space for the fixed EventsPanel when connected so
				// the panel never intercepts clicks on the chat composer / Send button.
				marginRight: status === "connected" ? "calc(420px + 5vh)" : "auto",
			}}
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

			<EventsPanel eventLog={eventLog} lifecycleLog={lifecycleLog} />
		</main>
	);
}
