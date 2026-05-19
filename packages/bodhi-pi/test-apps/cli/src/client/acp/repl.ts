import readline from "node:readline/promises";
import {
	type Agent,
	AgentSideConnection,
	type AnyMessage,
	type Client,
	ClientSideConnection,
	type Stream,
} from "@agentclientprotocol/sdk";
import {
	type createBodhiPiAgent,
	createBodhiPiClient,
	DEFAULT_AGENT_MODE,
	modelConfigFromOptions,
	type SessionStore,
} from "@bodhiapp/bodhi-pi";
import chalk from "chalk";
import { handleCommand, isCommand, type ReplState, refreshStateFromConfigOptions } from "../lib/commands.js";
import { createRenderer } from "../lib/render.js";

const INIT_PARAMS = {
	protocolVersion: 1,
	clientCapabilities: {
		fs: { readTextFile: false, writeTextFile: false },
		terminal: false,
	},
} as const;

export interface ReplOptions {
	factory: ReturnType<typeof createBodhiPiAgent>;
	cwd: string;
	sessionStore: SessionStore;
}

export async function runRepl(opts: ReplOptions): Promise<void> {
	const renderer = createRenderer();

	const a2c = new TransformStream<AnyMessage, AnyMessage>();
	const c2a = new TransformStream<AnyMessage, AnyMessage>();
	const agentStream: Stream = { readable: c2a.readable, writable: a2c.writable };
	const clientStream: Stream = { readable: a2c.readable, writable: c2a.writable };

	// Keep agentConn alive — it drives the agent-side message loop.
	const agentConn = new AgentSideConnection(opts.factory, agentStream);
	void agentConn;

	const state: ReplState = {
		sessionId: "",
		currentModelId: "",
		defaultModelId: "",
		models: [],
		currentMode: DEFAULT_AGENT_MODE,
		availableModes: [],
		availableCommands: [],
		closed: false,
	};

	const clientConn = new ClientSideConnection(
		(_agent: Agent): Client => ({
			sessionUpdate: async (params) => {
				const update = params.update;
				if (update.sessionUpdate === "available_commands_update") {
					state.availableCommands = update.availableCommands ?? [];
				} else if (update.sessionUpdate === "config_option_update") {
					refreshStateFromConfigOptions(state, update.configOptions);
				} else if (update.sessionUpdate === "session_info_update") {
					if (update.title) process.stdout.write(chalk.dim(`[session renamed: ${update.title}]\n`));
				}
				renderer.onNotification(params);
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
	refreshStateFromConfigOptions(state, created.configOptions ?? undefined);

	// terminal: false when piped so readline doesn't try raw-mode on a non-TTY.
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: process.stdin.isTTY ?? false,
	});

	process.stdout.write(`${chalk.bold(`bodhi-pi-cli`)}  cwd: ${opts.cwd}\n`);
	process.stdout.write(`session: ${state.sessionId.slice(0, 8)}…  type /help for commands\n`);
	if (!state.currentModelId) {
		const hint =
			derivedModels.length > 0
				? `pick one with /model <id>  (${derivedModels.map((m) => m.id).join(", ")})`
				: "configure provider auth with /login <provider> <api-key>";
		process.stdout.write(chalk.yellow(`[no model selected] ${hint}\n`));
	}
	process.stdout.write("\n");

	for (;;) {
		let line: string;
		try {
			line = await rl.question(`${chalk.cyan(`[${state.currentMode}]`)} ${chalk.green("> ")}`);
		} catch {
			break; // stdin EOF (Ctrl-D or piped input exhausted)
		}

		line = line.trim();
		if (!line) continue;

		const cmdName = isCommand(line) ? line.trim().split(/\s+/)[0].slice(1) : null;
		const isAgentCommand = cmdName !== null && state.availableCommands.some((c) => c.name === cmdName);

		if (isCommand(line) && !isAgentCommand) {
			const shouldExit = await handleCommand(line, {
				client: bodhiClient,
				state,
				sessionStore: opts.sessionStore,
				renderer,
				cwd: opts.cwd,
			});
			if (shouldExit) break;
		} else {
			if (state.closed) {
				process.stdout.write("session is closed. Use /new to start a fresh one or /resume <id>.\n");
				continue;
			}
			process.stdout.write("\n");
			try {
				const result = await bodhiClient.prompt(line, { sessionId: state.sessionId });
				renderer.flush();
				process.stdout.write(`${chalk.dim(`[${result.stopReason}]`)}\n`);
			} catch (err) {
				renderer.flush();
				process.stdout.write(`${chalk.red(`[error] ${String(err)}`)}\n`);
			}
		}
	}

	rl.close();
	// ACP TransformStreams keep the event loop alive; force exit cleanly.
	process.exit(0);
}
