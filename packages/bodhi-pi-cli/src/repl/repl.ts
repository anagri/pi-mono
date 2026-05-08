import readline from "node:readline/promises";
import {
	type Agent,
	AgentSideConnection,
	type AnyMessage,
	type AvailableCommand,
	type Client,
	ClientSideConnection,
	type Stream,
} from "@agentclientprotocol/sdk";
import type { createBodhiPiAgent, SessionStore } from "@bodhiapp/bodhi-pi";
import type { Api, Model } from "@mariozechner/pi-ai";
import chalk from "chalk";
import { handleCommand, isCommand, type ReplState } from "./commands.js";
import { createRenderer } from "./render.js";

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
	models: Model<Api>[];
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
		currentModelId: opts.models[0]?.id ?? "",
		models: opts.models,
		availableCommands: [],
	};

	const clientConn = new ClientSideConnection(
		(_agent: Agent): Client => ({
			sessionUpdate: async (params) => {
				const update = params.update as Record<string, unknown>;
				if (update.sessionUpdate === "available_commands_update") {
					state.availableCommands = (update.availableCommands as AvailableCommand[]) ?? [];
				}
				renderer.onNotification(params);
			},
			requestPermission: async () => ({ outcome: { outcome: "approved" } }),
		}),
		clientStream,
	);

	await clientConn.initialize(INIT_PARAMS);
	const { sessionId: initialSessionId } = await clientConn.newSession({ cwd: opts.cwd, mcpServers: [] });
	state.sessionId = initialSessionId;

	// terminal: false when piped so readline doesn't try raw-mode on a non-TTY.
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: process.stdin.isTTY ?? false,
	});

	process.stdout.write(`${chalk.bold(`bodhi-pi-cli`)}  cwd: ${opts.cwd}\n`);
	process.stdout.write(`session: ${state.sessionId.slice(0, 8)}…  type /help for commands\n\n`);

	for (;;) {
		let line: string;
		try {
			line = await rl.question(chalk.green("> "));
		} catch {
			break; // stdin EOF (Ctrl-D or piped input exhausted)
		}

		line = line.trim();
		if (!line) continue;

		const cmdName = isCommand(line) ? line.trim().split(/\s+/)[0].slice(1) : null;
		const isAgentCommand = cmdName !== null && state.availableCommands.some((c) => c.name === cmdName);

		if (isCommand(line) && !isAgentCommand) {
			const shouldExit = await handleCommand(line, {
				clientConn,
				state,
				sessionStore: opts.sessionStore,
				renderer,
				cwd: opts.cwd,
			});
			if (shouldExit) break;
		} else {
			process.stdout.write("\n");
			try {
				const result = await clientConn.prompt({
					sessionId: state.sessionId,
					prompt: [{ type: "text", text: line }],
				});
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
