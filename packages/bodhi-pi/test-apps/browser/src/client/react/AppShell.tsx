import type {
	AvailableCommand,
	ClientSideConnection,
	ContentBlock,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
	EventEntry,
	FrameEntry,
	SetupFormValues,
	TransportAdapter,
} from "@bodhiapp/bodhi-pi-test-app-utils/transport-types";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { extractModelFromConfigOptions, isSlash, tryHandleSlash } from "../lib/commands.ts";
import { emitOauthStatusEvent } from "../lib/oauth-event-bus.ts";
import { tryHandleSlash as tryHandleAcpSlash } from "../lib/slash-router.ts";
import { ChatPanel, type ChatMessage, type ChatPanelState, type ChatToolCall } from "./ChatPanel.tsx";
import { DevAcpIo } from "./DevAcpIo.tsx";
import { ErrorBanner } from "./ErrorBanner.tsx";
import { EventsPanel } from "./EventsPanel.tsx";
import { SetupForm } from "./SetupForm.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { WirePanel } from "./WirePanel.tsx";

type RootState = "needs-init" | "ready" | "streaming" | "closed" | "error";

const STREAMING_METHODS = new Set(["session/prompt", "session/load", "session/resume"]);

export interface AppShellProps {
	title: string;
	adapter: TransportAdapter;
	headerSlot?: ReactNode;
}

export function AppShell({ title, adapter, headerSlot }: AppShellProps) {
	const [state, setState] = useState<RootState>("needs-init");
	const [errorMsg, setErrorMsg] = useState<string>("");
	const [frames, setFrames] = useState<FrameEntry[]>([]);
	const [events, setEvents] = useState<EventEntry[]>([]);
	const [acpInput, setAcpInput] = useState<string>("");
	const [composerInput, setComposerInput] = useState<string>("");
	const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
	const [chatState, setChatState] = useState<ChatPanelState>("idle");
	const [currentModel, setCurrentModel] = useState<string>("");
	const [sessionId, setSessionId] = useState<string>("");
	const [workspaceRoot, setWorkspaceRoot] = useState<string>("");
	const availableCommandsRef = useRef<AvailableCommand[]>([]);

	const initializedRef = useRef(false);
	const seqRef = useRef(0);
	const inFlightStreamingRef = useRef<Set<string>>(new Set());
	const connRef = useRef<ClientSideConnection | null>(null);
	const cwdRef = useRef<string>("");
	const sessionIdRef = useRef<string>("");
	const activeSubagentGroupsRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		return () => {
			void adapter.cleanup();
		};
	}, [adapter]);

	const pushFrame = useCallback((f: Omit<FrameEntry, "seq">) => {
		setFrames((prev) => [...prev, { ...f, seq: prev.length + 1 }]);
		seqRef.current += 1;
	}, []);

	const openSubagentGroup = useCallback((childSessionId: string, profileName: string) => {
		activeSubagentGroupsRef.current.add(childSessionId);
		setChatMessages((prev) => [
			...prev,
			{
				id: `subagent-${childSessionId}`,
				role: "system",
				text: "",
				toolCalls: [],
				subagentGroup: {
					childSessionId,
					profileName,
					status: "running",
					messages: [],
				},
			},
		]);
	}, []);

	const closeSubagentGroup = useCallback(
		(childSessionId: string, status: "completed" | "cancelled" | "failed") => {
			activeSubagentGroupsRef.current.delete(childSessionId);
			setChatMessages((prev) =>
				prev.map((m) =>
					m.subagentGroup && m.subagentGroup.childSessionId === childSessionId
						? { ...m, subagentGroup: { ...m.subagentGroup, status } }
						: m,
				),
			);
		},
		[],
	);

	const pushEvent = useCallback(
		(type: string, payload: string) => {
			setEvents((prev) => [...prev, { seq: prev.length + 1, type, payload }]);
			if (type === "subagent_start") {
				try {
					const ev = JSON.parse(payload) as { childSessionId?: string; profileName?: string };
					if (ev.childSessionId && ev.profileName) openSubagentGroup(ev.childSessionId, ev.profileName);
				} catch {
					// nop
				}
				return;
			}
			if (type === "subagent_end") {
				try {
					const ev = JSON.parse(payload) as { childSessionId?: string; status?: string };
					if (ev.childSessionId) {
						const s =
							ev.status === "completed" || ev.status === "cancelled" || ev.status === "failed"
								? ev.status
								: "completed";
						closeSubagentGroup(ev.childSessionId, s);
					}
				} catch {
					// nop
				}
				return;
			}
			if (type === "mcp_oauth_status_change") {
				// HTTP+WS server-side /oauth/callback path completes silently — there's no popup-to-opener
				// postMessage path. Forward the lifecycle event to the in-process bus so the chat slash
				// command can resolve its in-flight promise on it.
				try {
					const event = JSON.parse(payload) as {
						slug?: string;
						status?: "started" | "completed" | "failed" | "cancelled";
						errorMessage?: string;
					};
					if (event.slug && event.status) {
						emitOauthStatusEvent({
							slug: event.slug,
							status: event.status,
							...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
						});
					}
				} catch {
					// payload not JSON or malformed — silently drop; slash command will rely on postMessage or time out.
				}
			}
		},
		[openSubagentGroup, closeSubagentGroup],
	);

	const applyContentBlocks = (blocks: ContentBlock[] | undefined): string => {
		if (!blocks) return "";
		let text = "";
		for (const b of blocks) {
			if (b.type === "text") text += b.text;
		}
		return text;
	};

	const onSessionUpdate = useCallback((n: SessionNotification) => {
		const u = n.update;
		if (u.sessionUpdate === "available_commands_update") {
			availableCommandsRef.current = u.availableCommands;
			return;
		}
		if (u.sessionUpdate === "config_option_update") {
			const m = extractModelFromConfigOptions(u.configOptions);
			if (m) setCurrentModel(m);
			return;
		}
		setChatMessages((prev) => {
			const next = [...prev];
			const isGrouped = activeSubagentGroupsRef.current.has(n.sessionId);
			const applyTo = (arr: ChatMessage[]): ChatMessage[] => {
				const out = [...arr];
				const upsertLast = (role: "user" | "assistant" | "system", text: string) => {
					const last = out[out.length - 1];
					if (last && last.role === role && last.toolCalls.length === 0 && !last.subagentGroup) {
						out[out.length - 1] = { ...last, text: last.text + text };
					} else {
						out.push({ id: `${role}-${out.length}`, role, text, toolCalls: [] });
					}
				};
				const addToolCall = (tc: ChatToolCall) => {
					const last = out[out.length - 1];
					if (last && last.role === "assistant" && !last.subagentGroup) {
						out[out.length - 1] = { ...last, toolCalls: [...last.toolCalls, tc] };
					} else {
						out.push({ id: `assistant-${out.length}`, role: "assistant", text: "", toolCalls: [tc] });
					}
				};
				const updateToolCall = (id: string, patch: Partial<ChatToolCall>) => {
					for (let i = out.length - 1; i >= 0; i--) {
						const m = out[i];
						if (!m) continue;
						const idx = m.toolCalls.findIndex((t) => t.id === id);
						if (idx !== -1) {
							const updated = [...m.toolCalls];
							const existing = updated[idx]!;
							updated[idx] = { ...existing, ...patch };
							out[i] = { ...m, toolCalls: updated };
							return;
						}
					}
				};
				switch (u.sessionUpdate) {
					case "user_message_chunk":
						upsertLast("user", applyContentBlocks([u.content]));
						break;
					case "agent_message_chunk":
						upsertLast("assistant", applyContentBlocks([u.content]));
						break;
					case "tool_call":
						addToolCall({
							id: u.toolCallId,
							name: u.title ?? u.kind ?? "tool",
							status: mapToolStatus(u.status),
						});
						break;
					case "tool_call_update":
						updateToolCall(u.toolCallId, u.status ? { status: mapToolStatus(u.status) } : {});
						break;
				}
				return out;
			};
			if (isGrouped) {
				return next.map((m) =>
					m.subagentGroup && m.subagentGroup.childSessionId === n.sessionId
						? { ...m, subagentGroup: { ...m.subagentGroup, messages: applyTo(m.subagentGroup.messages) } }
						: m,
				);
			}
			return applyTo(next);
		});
	}, []);

	const onSetupSubmit = useCallback(
		async (values: SetupFormValues) => {
			if (!values.userId) {
				setErrorMsg("user-id is required");
				setState("error");
				return;
			}
			if (!values.userEmail) {
				setErrorMsg("user-email is required");
				setState("error");
				return;
			}
			try {
				const result = await adapter.connect(values, {
					onFrame: pushFrame,
					onEvent: pushEvent,
					onSessionUpdate,
				});
				connRef.current = result.conn;
				cwdRef.current = result.cwd;
				setWorkspaceRoot(result.workspaceRoot);
				setState("ready");
			} catch (err) {
				setErrorMsg((err as Error).message ?? String(err));
				setState("error");
			}
		},
		[adapter, pushFrame, pushEvent, onSessionUpdate],
	);

	const dispatchAcp = useCallback(
		async (method: string, params: Record<string, unknown> | undefined): Promise<unknown> => {
			const conn = connRef.current;
			if (!conn) throw new Error("connection not ready");
			const c = conn as unknown as Record<string, (p: unknown) => Promise<unknown>>;
			switch (method) {
				case "initialize":
					return c.initialize!(params);
				case "session/new":
					return c.newSession!(params);
				case "session/load":
					return c.loadSession!(params);
				case "session/resume":
					return c.resumeSession!(params);
				case "session/list":
					return c.listSessions!(params);
				case "session/close":
					return c.closeSession!(params);
				case "session/prompt":
					return c.prompt!(params);
				case "session/setSessionConfigOption":
					return c.setSessionConfigOption!(params);
				case "session/cancel":
					return c.cancel!(params);
				default:
					return (conn as unknown as { extMethod: (m: string, p: unknown) => Promise<unknown> }).extMethod(
						method,
						params ?? {},
					);
			}
		},
		[],
	);

	const onAcpSubmit = useCallback(async () => {
		const raw = acpInput;
		setAcpInput("");
		const slashResult = await tryHandleAcpSlash(raw);
		if (slashResult) {
			const synthId = `slash-${seqRef.current + 1}`;
			pushFrame({
				direction: "out",
				kind: "request",
				method: slashResult.method,
				rpcId: synthId,
				payload: JSON.stringify({ jsonrpc: "2.0", id: synthId, method: slashResult.method, params: { input: raw } }),
			});
			pushFrame({
				direction: "in",
				kind: "response",
				method: slashResult.method,
				rpcId: synthId,
				payload: JSON.stringify({ jsonrpc: "2.0", id: synthId, result: slashResult.result }),
			});
			return;
		}
		let body: { id?: string | number; method?: string; params?: unknown };
		try {
			body = JSON.parse(raw);
		} catch (err) {
			pushFrame({
				direction: "in",
				kind: "response",
				method: "_test/parse-error",
				rpcId: "0",
				payload: JSON.stringify({ error: { code: -32700, message: (err as Error).message ?? String(err) } }),
			});
			return;
		}
		const method = String(body.method ?? "");
		const params = body.params as Record<string, unknown> | undefined;
		const isStreaming = STREAMING_METHODS.has(method);
		if (isStreaming) {
			inFlightStreamingRef.current.add(method);
			setState("streaming");
		}
		try {
			const result = await dispatchAcp(method, params);
			if (method === "initialize") initializedRef.current = true;
			if ((method === "session/new" || method === "session/load" || method === "session/resume") && result && typeof result === "object") {
				const r = result as { sessionId?: string };
				const sid =
					typeof r.sessionId === "string"
						? r.sessionId
						: params && typeof (params as { sessionId?: string }).sessionId === "string"
							? (params as { sessionId: string }).sessionId
							: "";
				if (sid) {
					sessionIdRef.current = sid;
					setSessionId(sid);
				}
			}
		} catch (err) {
			pushFrame({
				direction: "in",
				kind: "response",
				method: `${method}/error`,
				rpcId: String(body.id ?? "0"),
				payload: JSON.stringify({ error: { message: (err as Error).message ?? String(err) } }),
			});
		} finally {
			if (isStreaming) {
				inFlightStreamingRef.current.delete(method);
				if (inFlightStreamingRef.current.size === 0) setState("ready");
			}
		}
	}, [acpInput, pushFrame, dispatchAcp]);

	const onAcpCancel = useCallback(async () => {
		const sid = sessionIdRef.current;
		const conn = connRef.current;
		if (!sid || !conn) return;
		try {
			await (conn as unknown as { cancel: (p: { sessionId: string }) => Promise<unknown> }).cancel({ sessionId: sid });
		} catch {
			// best-effort
		}
	}, []);

	const pushUserMessage = useCallback((text: string) => {
		setChatMessages((prev) => [
			...prev,
			{ id: `user-${prev.length}`, role: "user", text, toolCalls: [] },
		]);
	}, []);

	const pushSystemMessage = useCallback((text: string, dataAttrs?: Record<string, string>) => {
		setChatMessages((prev) => [
			...prev,
			{ id: `system-${prev.length}`, role: "system", text, toolCalls: [], ...(dataAttrs ? { dataAttrs } : {}) },
		]);
	}, []);

	const ensureInitialized = useCallback(async (): Promise<void> => {
		if (initializedRef.current) return;
		await dispatchAcp("initialize", {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		});
		initializedRef.current = true;
	}, [dispatchAcp]);

	const ensureSession = useCallback(async (): Promise<string> => {
		if (sessionIdRef.current) return sessionIdRef.current;
		const r = (await dispatchAcp("session/new", { mcpServers: [], cwd: cwdRef.current })) as {
			sessionId: string;
			configOptions?: Parameters<typeof extractModelFromConfigOptions>[0];
		};
		sessionIdRef.current = r.sessionId;
		setSessionId(r.sessionId);
		const m = extractModelFromConfigOptions(r.configOptions);
		if (m) setCurrentModel(m);
		return r.sessionId;
	}, [dispatchAcp]);

	const onComposerSend = useCallback(async () => {
		const input = composerInput.trim();
		if (!input) return;
		setComposerInput("");
		try {
			await ensureInitialized();
			const sid = await ensureSession();
			pushUserMessage(input);
			if (isSlash(input)) {
				const outcome = await tryHandleSlash(input, {
					conn: connRef.current!,
					cwd: cwdRef.current,
					state: { sessionId: sid, availableCommands: availableCommandsRef.current },
					pushSystemMessage,
					setSessionId: (id) => {
						sessionIdRef.current = id;
						setSessionId(id);
					},
					setCurrentModel,
				});
				if (outcome.handled) return;
			}
			setChatState("streaming");
			try {
				await dispatchAcp("session/prompt", {
					sessionId: sessionIdRef.current,
					prompt: [{ type: "text", text: input }],
				});
			} finally {
				setChatState("idle");
			}
		} catch (err) {
			setErrorMsg((err as Error).message ?? String(err));
			setChatState("idle");
		}
	}, [composerInput, dispatchAcp, ensureInitialized, ensureSession, pushSystemMessage, pushUserMessage]);

	const onComposerStop = useCallback(async () => {
		const sid = sessionIdRef.current;
		if (!sid) return;
		try {
			await dispatchAcp("session/cancel", { sessionId: sid });
		} catch {
			// best-effort
		}
	}, [dispatchAcp]);

	return (
		<main className="app-shell" data-testid="test-app-root" data-test-state={state}>
			<section className="app-shell-main">
				<StatusBar title={title} model={currentModel} sessionId={sessionId} state={state} />
				{headerSlot}
				{state === "error" && <ErrorBanner message={errorMsg} />}
				{state === "needs-init" && <SetupForm onSubmit={onSetupSubmit} />}
				{(state === "ready" || state === "streaming") && (
					<>
						<ChatPanel
							state={chatState}
							currentModel={currentModel}
							sessionId={sessionId}
							messages={chatMessages}
							composerValue={composerInput}
							onComposerChange={setComposerInput}
							onSend={onComposerSend}
							onStop={onComposerStop}
						/>
						{/* `open` keeps the acp-input textarea visible so page-driven
						harnesses can fill it without first expanding the details
						element. Users can still collapse it manually. */}
						<details className="dev-acp-io" open>
							<summary>dev: raw ACP I/O</summary>
							<DevAcpIo
								workspaceRoot={workspaceRoot}
								value={acpInput}
								onChange={setAcpInput}
								onSubmit={onAcpSubmit}
								onCancel={onAcpCancel}
							/>
						</details>
					</>
				)}
			</section>
			<aside className="app-shell-rail">
				<WirePanel frames={frames} />
				<EventsPanel events={events} />
			</aside>
		</main>
	);
}

function mapToolStatus(status: string | undefined): "running" | "completed" | "failed" {
	if (status === "completed") return "completed";
	if (status === "failed") return "failed";
	return "running";
}
