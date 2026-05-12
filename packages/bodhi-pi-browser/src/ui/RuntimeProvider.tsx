import type { AvailableCommand, ClientSideConnection } from "@agentclientprotocol/sdk";
import { createBodhiPiClient, modelConfigFromOptions, type BodhiPiClient, type ModelOption } from "@bodhiapp/bodhi-pi";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { dispatchNotification } from "../runtime/render";
import { type AgentRuntime, startAgentRuntime } from "../runtime/runtime";
import { clearLastSessionId, readLastSessionId, writeLastSessionId } from "../runtime/session-storage";
import { useChatStore } from "../store/chatStore";
import type { WorkspaceProvider } from "../workspace/provider";
import { handleCommand, isCommand } from "./commands";

interface RuntimeContextValue {
	conn: ClientSideConnection | null;
	client: BodhiPiClient | null;
	sessionId: string;
	currentModelId: string;
	models: ModelOption[];
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
	/**
	 * Spawns the agent worker. Host-owned so Vite can resolve the worker URL
	 * against host source: `() => new Worker(new URL("./agent/worker.ts", import.meta.url), { type: "module" })`.
	 */
	workerFactory: () => Worker;
	/**
	 * Optional zero-arg async factory that returns a `MessagePort` connected
	 * to a sandboxed iframe. Hosts running under a strict CSP (MV3 chrome
	 * extensions) supply one; the runtime hands the port to the worker via
	 * the `init` message. Called once on first runtime start.
	 */
	sandboxPortFactory?: () => Promise<MessagePort>;
}

export function RuntimeProvider({
	workspace,
	onUnmount,
	children,
	workerFactory,
	sandboxPortFactory,
}: RuntimeProviderProps) {
	const runtimeRef = useRef<AgentRuntime | null>(null);
	const clientRef = useRef<BodhiPiClient | null>(null);
	const [conn, setConn] = useState<ClientSideConnection | null>(null);
	const [client, setClient] = useState<BodhiPiClient | null>(null);
	const [models, setModels] = useState<ModelOption[]>([]);
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
			const sandboxPort = sandboxPortFactory ? await sandboxPortFactory() : undefined;
			const runtime = await startAgentRuntime({
				workspace,
				workerFactory,
				...(sandboxPort !== undefined ? { sandboxPort } : {}),
				onNotification: (notif) => {
					dispatchNotification(notif, {
						appendChunk,
						addMessage,
						addSystemMessage,
						addToolCall,
						updateToolCall,
						setAvailableCommands,
						refreshConfigOptions: (options) => {
							const next = modelConfigFromOptions(options);
							setModels(next.models);
							if (next.currentModelId) {
								setDefaultModelId(next.currentModelId);
								setCurrentModelId(next.currentModelId);
							}
						},
						setSessionTitle: (title) => {
							if (title) addSystemMessage(`[session renamed: ${title}]`);
						},
					});
				},
			});

			if (cancelled) {
				runtime.dispose();
				return;
			}
			runtimeRef.current = runtime;
			const bodhiClient = createBodhiPiClient(runtime.conn, { cwd: workspace.rootPath });
			clientRef.current = bodhiClient;

			// Auto-resume per-tab last session if Dexie still has it.
			const lastId = readLastSessionId();
			let activeId: string | undefined;
			if (lastId) {
				try {
					await bodhiClient.loadSession({
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
				const created = await bodhiClient.newSession({
					cwd: workspace.rootPath,
					mcpServers: [],
				});
				activeId = created.sessionId;
			}
			if (cancelled) {
				runtime.dispose();
				return;
			}

			const { models: derivedModels, currentModelId: derivedDefault } = bodhiClient.models();
			setModels(derivedModels);
			setDefaultModelId(derivedDefault);
			setSessionId(activeId);
			writeLastSessionId(activeId);
			setCurrentModelId(derivedDefault);
			setConn(runtime.conn);
			setClient(bodhiClient);
			setStatus("idle");
			if (!derivedDefault) {
				addSystemMessage(
					derivedModels.length > 0
						? `[no model selected] pick one with /model <id>  (${derivedModels.map((m) => m.id).join(", ")})`
						: `[no model selected] configure provider auth with /login <provider> <api-key>`,
				);
			}
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
			clientRef.current = null;
		};
		// All captured setters are referentially stable (Zustand bound actions + useState setters);
		// `workspace` is the only re-init trigger.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workspace, workerFactory, sandboxPortFactory]);

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
		const c = clientRef.current;
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
					client: c,
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
			await c.prompt(text, { sessionId: sid });
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
		const c = clientRef.current;
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
				client,
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
