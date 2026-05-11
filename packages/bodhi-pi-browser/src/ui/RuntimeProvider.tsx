import type { AvailableCommand, ClientSideConnection, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { dispatchNotification } from "../runtime/render";
import { type AgentRuntime, startAgentRuntime } from "../runtime/runtime";
import { clearLastSessionId, readLastSessionId, writeLastSessionId } from "../runtime/session-storage";
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

function modelsFromConfigOptions(options: readonly SessionConfigOption[] | undefined): {
	models: Model<Api>[];
	defaultModelId: string;
} {
	const modelOption = options?.find((o) => o.id === "model");
	if (!modelOption || modelOption.type !== "select") return { models: [], defaultModelId: "" };
	const items = modelOption.options ?? [];
	// `options` is `(Option | Group)[]`; flatten group children into top-level options.
	const flat: Array<{ value: string; name?: string }> = [];
	for (const item of items) {
		if ("value" in item) flat.push({ value: item.value, ...(item.name ? { name: item.name } : {}) });
	}
	const models = flat.map(
		(o): Model<Api> =>
			({
				id: o.value,
				name: o.name ?? o.value,
				provider: "unknown",
				api: "unknown",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			}) as unknown as Model<Api>,
	);
	return { models, defaultModelId: (modelOption.currentValue as string) ?? "" };
}

export function RuntimeProvider({
	workspace,
	onUnmount,
	children,
	workerFactory,
	sandboxPortFactory,
}: RuntimeProviderProps) {
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
			let configOptions: readonly SessionConfigOption[] | undefined;
			if (lastId) {
				try {
					const loaded = await runtime.conn.loadSession({
						sessionId: lastId,
						cwd: workspace.rootPath,
						mcpServers: [],
					});
					configOptions = loaded.configOptions ?? undefined;
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
				configOptions = created.configOptions ?? undefined;
				activeId = created.sessionId;
			}
			if (cancelled) {
				runtime.dispose();
				return;
			}

			const { models: derivedModels, defaultModelId: derivedDefault } = modelsFromConfigOptions(configOptions);
			setModels(derivedModels);
			setDefaultModelId(derivedDefault);
			setSessionId(activeId);
			writeLastSessionId(activeId);
			setCurrentModelId(derivedDefault);
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
					refreshConfigOptions: (options) => {
						const next = modelsFromConfigOptions(options);
						setModels(next.models);
						if (next.defaultModelId) {
							setDefaultModelId(next.defaultModelId);
							setCurrentModelId(next.defaultModelId);
						}
					},
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
