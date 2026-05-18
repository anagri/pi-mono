import type { Agent, AnyMessage, SessionNotification } from "@agentclientprotocol/sdk";
import { AgentSideConnection, type Client, ClientSideConnection, type Stream } from "@agentclientprotocol/sdk";
import {
	type createBodhiPiAgent,
	createBodhiPiClient,
	modelConfigFromOptions,
	type SessionStore,
} from "@bodhiapp/bodhi-pi";
import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	type EditorTheme,
	ProcessTerminal,
	type SlashCommand,
	Text,
	TUI,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import {
	BUILTIN_COMMANDS,
	type CmdState,
	handleCommand,
	isCommand,
	refreshStateFromConfigOptions,
} from "../../commands.js";
import { FooterComponent } from "./components/footer.js";
import { AssistantMessageComponent, SystemMessageComponent, UserMessageComponent } from "./components/message.js";
import { ToolCallComponent } from "./components/tool-call.js";

const INIT_PARAMS = {
	protocolVersion: 1,
	clientCapabilities: {
		fs: { readTextFile: false, writeTextFile: false },
		terminal: false,
	},
} as const;

const EDITOR_THEME: EditorTheme = {
	borderColor: chalk.dim,
	selectList: {
		selectedPrefix: chalk.cyan,
		selectedText: chalk.bgBlue.white,
		description: chalk.dim,
		scrollInfo: chalk.dim,
		noMatch: chalk.dim,
	},
};

export interface InteractiveModeOptions {
	factory: ReturnType<typeof createBodhiPiAgent>;
	cwd: string;
	sessionStore: SessionStore;
}

export async function runInteractiveMode(opts: InteractiveModeOptions): Promise<void> {
	const ui = new TUI(new ProcessTerminal(), true);
	ui.setClearOnShrink(true);

	const chatContainer = new Container();
	const footer = new FooterComponent();
	const editor = new Editor(ui, EDITOR_THEME, { paddingX: 1, autocompleteMaxVisible: 8 });

	ui.addChild(chatContainer);
	ui.addChild(new Text(chalk.dim("─".repeat(60)), 0, 0));
	ui.addChild(editor);
	ui.addChild(footer);
	ui.setFocus(editor);

	const state: CmdState = {
		sessionId: "",
		currentModelId: "",
		defaultModelId: "",
		models: [],
		availableCommands: [],
		closed: false,
	};

	const pendingTools = new Map<string, ToolCallComponent>();
	let streamingComponent: AssistantMessageComponent | undefined;
	let agentRunning = false;

	const a2c = new TransformStream<AnyMessage, AnyMessage>();
	const c2a = new TransformStream<AnyMessage, AnyMessage>();
	const agentStream: Stream = { readable: c2a.readable, writable: a2c.writable };
	const clientStream: Stream = { readable: a2c.readable, writable: c2a.writable };

	const agentConn = new AgentSideConnection(opts.factory, agentStream);
	void agentConn;

	function addSystemMsg(text: string): void {
		chatContainer.addChild(new SystemMessageComponent(text));
		ui.invalidate();
	}

	function onNotification(notif: SessionNotification): void {
		const update = notif.update as Record<string, unknown>;
		const kind = update.sessionUpdate as string;

		if (kind === "agent_message_chunk") {
			const content = update.content as { type: string; text?: string };
			if (content?.type === "text" && content.text) {
				if (!streamingComponent) {
					streamingComponent = new AssistantMessageComponent();
					chatContainer.addChild(streamingComponent);
				}
				streamingComponent.appendChunk(content.text);
				ui.invalidate();
			}
		} else if (kind === "tool_call") {
			if (update.status === "in_progress") {
				const toolCallId = update.toolCallId as string;
				const title = (update.title as string) ?? (update.toolName as string) ?? "tool";
				const comp = new ToolCallComponent(title);
				pendingTools.set(toolCallId, comp);
				chatContainer.addChild(comp);
				ui.invalidate();
			}
		} else if (kind === "tool_call_update") {
			const toolCallId = update.toolCallId as string;
			const comp = pendingTools.get(toolCallId);
			if (comp) {
				const status = update.status as string;
				if (status === "completed") {
					comp.setCompleted(update.content);
					pendingTools.delete(toolCallId);
					ui.invalidate();
				} else if (status === "failed") {
					comp.setFailed(update.content);
					pendingTools.delete(toolCallId);
					ui.invalidate();
				}
			}
		} else if (kind === "config_option_update") {
			const configOptions = update.configOptions as Parameters<typeof refreshStateFromConfigOptions>[1];
			refreshStateFromConfigOptions(state, configOptions);
			footer.setModel(state.currentModelId);
			ui.invalidate();
		} else if (kind === "available_commands_update") {
			state.availableCommands = (update.availableCommands as typeof state.availableCommands) ?? [];
			updateAutocomplete();
		} else if (kind === "session_info_update") {
			if (update.title) addSystemMsg(`[session renamed: ${update.title as string}]`);
		} else if (kind === "user_message_chunk") {
			const content = update.content as { type: string; text?: string };
			if (content?.type === "text" && content.text) {
				chatContainer.addChild(new UserMessageComponent(content.text));
				ui.invalidate();
			}
		}
	}

	const clientConn = new ClientSideConnection(
		(_agent: Agent): Client => ({
			sessionUpdate: async (params) => {
				onNotification(params);
			},
			requestPermission: async () => ({ outcome: { outcome: "approved" } }),
		}),
		clientStream,
	);

	await clientConn.initialize(INIT_PARAMS);
	const bodhiClient = createBodhiPiClient(clientConn, { cwd: opts.cwd });
	const created = await bodhiClient.newSession({ cwd: opts.cwd, mcpServers: [] });
	state.sessionId = created.sessionId;

	const { models: derivedModels, currentModelId: derivedDefault } = modelConfigFromOptions(
		created.configOptions ?? undefined,
	);
	state.models = derivedModels;
	state.defaultModelId = derivedDefault;
	state.currentModelId = derivedDefault;

	footer.setModel(state.currentModelId);
	footer.setSessionId(state.sessionId);

	function updateAutocomplete(): void {
		const slashCommands: SlashCommand[] = [
			...BUILTIN_COMMANDS.map((c) => ({
				name: c.name,
				description: c.description,
				...(c.input ? { argumentHint: c.input.hint } : {}),
			})),
			...state.availableCommands
				.filter((c) => !BUILTIN_COMMANDS.some((b) => b.name === c.name))
				.map((c) => ({
					name: c.name,
					description: c.description,
					...(c.input ? { argumentHint: c.input.hint } : {}),
				})),
		];
		const provider = new CombinedAutocompleteProvider(slashCommands, opts.cwd);
		editor.setAutocompleteProvider(provider);
	}

	updateAutocomplete();

	addSystemMsg(`bodhi-pi  cwd: ${opts.cwd}`);
	addSystemMsg(`session: ${state.sessionId.slice(0, 8)}…  type /help for commands`);
	if (!state.currentModelId) {
		const hint =
			derivedModels.length > 0
				? `pick one with /model <id>  (${derivedModels.map((m) => m.id).join(", ")})`
				: "configure provider auth with /login <provider> <api-key>";
		addSystemMsg(chalk.yellow(`[no model selected] ${hint}`));
	}

	ui.start();

	editor.onSubmit = async (text) => {
		const trimmed = text.trim();
		if (!trimmed) return;

		editor.addToHistory(trimmed);
		editor.setText("");

		const cmdName = isCommand(trimmed) ? trimmed.split(/\s+/)[0].slice(1) : null;
		const isAgentCommand = cmdName !== null && state.availableCommands.some((c) => c.name === cmdName);

		if (isCommand(trimmed) && !isAgentCommand) {
			const shouldExit = await handleCommand(trimmed, {
				client: bodhiClient,
				state,
				sessionStore: opts.sessionStore,
				cwd: opts.cwd,
				write: (t) => addSystemMsg(t.replace(/\n$/, "")),
			});
			footer.setModel(state.currentModelId);
			footer.setSessionId(state.sessionId);
			updateAutocomplete();
			ui.invalidate();
			if (shouldExit) {
				ui.stop();
				process.exit(0);
			}
			return;
		}

		if (state.closed) {
			addSystemMsg("session is closed. Use /new to start a fresh one or /resume <id>.");
			return;
		}

		if (agentRunning) return;

		chatContainer.addChild(new UserMessageComponent(trimmed));
		streamingComponent = undefined;
		agentRunning = true;
		footer.setStatus("thinking…");
		ui.invalidate();

		try {
			const result = await bodhiClient.prompt(trimmed, { sessionId: state.sessionId });
			footer.setStatus("");
			addSystemMsg(chalk.dim(`[${result.stopReason}]`));
		} catch (err) {
			footer.setStatus("");
			addSystemMsg(chalk.red(`[error] ${String(err)}`));
		} finally {
			agentRunning = false;
			streamingComponent = undefined;
			ui.invalidate();
		}
	};

	await new Promise<void>((resolve) => {
		const removeListener = ui.addInputListener((data) => {
			if (data === "\x03") {
				removeListener();
				ui.stop();
				resolve();
				return { consume: true };
			}
			return undefined;
		});
	});

	process.exit(0);
}
