import type { AvailableCommand, ClientSideConnection } from "@agentclientprotocol/sdk";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { dispatchNotification } from "../agent/render";
import { type AgentRuntime, startAgentRuntime } from "../agent/runtime";
import { readEnv } from "../env";
import { useChatStore } from "../store/chatStore";
import { handleCommand, isCommand } from "./commands";

interface RuntimeContextValue {
	conn: ClientSideConnection | null;
	sessionId: string;
	currentModelId: string;
	models: Model<Api>[];
	availableCommands: AvailableCommand[];
	prompt: (text: string) => Promise<void>;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export function useRuntime(): RuntimeContextValue {
	const ctx = useContext(RuntimeContext);
	if (!ctx) throw new Error("useRuntime must be used within <RuntimeProvider>");
	return ctx;
}

export function RuntimeProvider({ children }: { children: React.ReactNode }) {
	const runtimeRef = useRef<AgentRuntime | null>(null);
	const [conn, setConn] = useState<ClientSideConnection | null>(null);
	const [models, setModels] = useState<Model<Api>[]>([]);
	const [defaultModelId, setDefaultModelId] = useState<string>("");
	const [availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([]);
	const { setStatus, setSessionId, setCurrentModelId, addMessage, appendChunk, addSystemMessage, clear } = useChatStore();
	const sessionId = useChatStore((s) => s.sessionId);
	const currentModelId = useChatStore((s) => s.currentModelId);

	useEffect(() => {
		let cancelled = false;
		setStatus("initializing");

		(async () => {
			const env = readEnv();
			setModels(env.models);
			setDefaultModelId(env.defaultModelId);

			const runtime = await startAgentRuntime({
				models: env.models,
				defaultModelId: env.defaultModelId,
				apiKeys: env.apiKeys,
				onNotification: (notif) => {
					dispatchNotification(notif, {
						appendChunk,
						addMessage,
						addSystemMessage,
						setAvailableCommands,
					});
				},
			});

			if (cancelled) {
				runtime.dispose();
				return;
			}

			runtimeRef.current = runtime;

			const newSession = await runtime.conn.newSession({ cwd: "/", mcpServers: [] });
			if (cancelled) {
				runtime.dispose();
				return;
			}

			setSessionId(newSession.sessionId);
			setCurrentModelId(env.defaultModelId);
			setConn(runtime.conn);
			setStatus("idle");
		})().catch((err) => {
			if (!cancelled) {
				addSystemMessage(`error: ${String(err)}`);
				setStatus("error");
			}
		});

		return () => {
			cancelled = true;
			runtimeRef.current?.dispose();
			runtimeRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function prompt(text: string): Promise<void> {
		const c = conn;
		if (!c) {
			addSystemMessage("error: runtime not ready");
			return;
		}

		// Slash-command routing mirrors bodhi-pi-cli/src/repl/repl.ts:90-101.
		// Local commands handled here; agent-announced commands fall through
		// as a normal prompt turn.
		if (isCommand(text)) {
			const cmdName = text.trim().split(/\s+/)[0].slice(1);
			const isAgentCommand = availableCommands.some((c) => c.name === cmdName);
			if (!isAgentCommand) {
				addMessage("user", text);
				const handled = await handleCommand(text, {
					conn: c,
					state: {
						sessionId: useChatStore.getState().sessionId,
						currentModelId: useChatStore.getState().currentModelId,
						defaultModelId,
						models,
						availableCommands,
					},
					addSystemMessage,
					setCurrentModelId,
					setSessionId,
					setStatus,
					clear,
				});
				if (handled) return;
			}
		}

		// Block prompts when the session is closed; user must /new or /resume first.
		if (useChatStore.getState().status === "closed") {
			addSystemMessage("session is closed. Use /new to start a fresh one or /resume <id>.");
			return;
		}

		const sid = useChatStore.getState().sessionId;
		addMessage("user", text);
		setStatus("streaming");
		try {
			await c.prompt({ sessionId: sid, prompt: [{ type: "text", text }] });
		} catch (err) {
			addSystemMessage(`error: ${String(err)}`);
		} finally {
			setStatus("idle");
		}
	}

	return (
		<RuntimeContext.Provider
			value={{ conn, sessionId, currentModelId, models, availableCommands, prompt }}
		>
			{children}
		</RuntimeContext.Provider>
	);
}
