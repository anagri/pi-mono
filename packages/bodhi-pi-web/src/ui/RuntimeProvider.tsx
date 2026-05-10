import type { AvailableCommand, ClientSideConnection } from "@agentclientprotocol/sdk";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { dispatchNotification } from "../agent/render";
import { type AgentRuntime, startAgentRuntime } from "../agent/runtime";
import { clearLastSessionId, readLastSessionId, writeLastSessionId } from "../agent/session-storage";
import { readEnv } from "../env";
import { useChatStore } from "../store/chatStore";
import type { WorkspaceProvider } from "../workspace/provider";
import { handleCommand, isCommand } from "./commands";

interface RuntimeContextValue {
	conn: ClientSideConnection | null;
	sessionId: string;
	currentModelId: string;
	models: Model<Api>[];
	availableCommands: AvailableCommand[];
	prompt: (text: string) => Promise<void>;
	cancelPrompt: () => Promise<void>;
	unmount: () => Promise<void>;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export function useRuntime(): RuntimeContextValue {
	const ctx = useContext(RuntimeContext);
	if (!ctx) throw new Error("useRuntime must be used within <RuntimeProvider>");
	return ctx;
}

export interface RuntimeProviderProps {
	workspace: WorkspaceProvider;
	onUnmount?: () => void | Promise<void>;
	children: React.ReactNode;
}

export function RuntimeProvider({ workspace, onUnmount, children }: RuntimeProviderProps) {
	const runtimeRef = useRef<AgentRuntime | null>(null);
	const [conn, setConn] = useState<ClientSideConnection | null>(null);
	const [models, setModels] = useState<Model<Api>[]>([]);
	const [defaultModelId, setDefaultModelId] = useState<string>("");
	const [availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([]);
	const {
		setStatus,
		setSessionId,
		setCurrentModelId,
		setMountPath,
		addMessage,
		appendChunk,
		addSystemMessage,
		addToolCall,
		updateToolCall,
		clear,
	} = useChatStore();
	const sessionId = useChatStore((s) => s.sessionId);
	const currentModelId = useChatStore((s) => s.currentModelId);
	const status = useChatStore((s) => s.status);

	useEffect(() => {
		let cancelled = false;
		setStatus("initializing");
		setMountPath(workspace.rootPath);

		(async () => {
			const env = readEnv();
			setModels(env.models);
			setDefaultModelId(env.defaultModelId);

			const runtime = await startAgentRuntime({
				models: env.models,
				defaultModelId: env.defaultModelId,
				apiKeys: env.apiKeys,
				workspace,
				onNotification: (notif) => {
					dispatchNotification(notif, {
						appendChunk,
						addMessage,
						addSystemMessage,
						addToolCall,
						updateToolCall,
						setAvailableCommands,
					});
				},
			});

			if (cancelled) {
				runtime.dispose();
				return;
			}
			runtimeRef.current = runtime;

			// Auto-resume per-tab last session if Dexie still has it.
			const lastId = readLastSessionId();
			let activeId: string | undefined;
			if (lastId) {
				try {
					await runtime.conn.loadSession({
						sessionId: lastId,
						cwd: workspace.rootPath,
						mcpServers: [],
					});
					activeId = lastId;
				} catch {
					clearLastSessionId();
				}
			}
			if (!activeId) {
				const created = await runtime.conn.newSession({
					cwd: workspace.rootPath,
					mcpServers: [],
				});
				activeId = created.sessionId;
			}
			if (cancelled) {
				runtime.dispose();
				return;
			}

			setSessionId(activeId);
			writeLastSessionId(activeId);
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
		// All captured setters are referentially stable (Zustand bound actions + useState setters);
		// `workspace` is the only re-init trigger.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workspace]);

	useEffect(() => {
		if (status === "closed") {
			clearLastSessionId();
			return;
		}
		if (sessionId && sessionId !== "local") {
			writeLastSessionId(sessionId);
		}
	}, [sessionId, status]);

	async function prompt(text: string): Promise<void> {
		const c = conn;
		if (!c) {
			addSystemMessage("error: runtime not ready");
			return;
		}

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
					cwd: workspace.rootPath,
				});
				if (handled) return;
			}
		}

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

	async function unmount(): Promise<void> {
		if (!onUnmount) return;
		await onUnmount();
	}

	async function cancelPrompt(): Promise<void> {
		const c = conn;
		if (!c) return;
		const sid = useChatStore.getState().sessionId;
		if (!sid || sid === "local") return;
		try {
			// `session/cancel` is a notification — bodhi-pi maps it to a turn
			// abort, the inflight `prompt()` resolves with stopReason "cancelled",
			// and the existing finally-block in `prompt()` flips status back to idle.
			await c.cancel({ sessionId: sid });
		} catch (err) {
			addSystemMessage(`error: ${String(err)}`);
		}
	}

	return (
		<RuntimeContext.Provider
			value={{
				conn,
				sessionId,
				currentModelId,
				models,
				availableCommands,
				prompt,
				cancelPrompt,
				unmount,
			}}
		>
			{children}
		</RuntimeContext.Provider>
	);
}
