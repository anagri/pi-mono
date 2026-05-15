import readline from "node:readline";
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
	type McpAuthMode,
	type SessionStore,
} from "@bodhiapp/bodhi-pi";

const INIT_PARAMS = {
	protocolVersion: 1,
	clientCapabilities: {
		fs: { readTextFile: false, writeTextFile: false },
		terminal: false,
	},
} as const;

interface ParsedMcpAdd {
	url?: string;
	command?: string;
	cmdArgs?: string[];
	auth?: { mode: McpAuthMode; headers?: Array<{ name: string; value: string }> };
	label?: string;
	error?: string;
}

function parseMcpAddArgs(rest: string[]): ParsedMcpAdd {
	const out: ParsedMcpAdd = {};
	const headers: Array<{ name: string; value: string }> = [];
	for (const tok of rest) {
		const m = /^([a-zA-Z_][\w-]*)=(.*)$/.exec(tok);
		if (!m) continue;
		const key = m[1] as string;
		const raw = m[2] as string;
		const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
		if (key === "url") out.url = value;
		else if (key === "command") out.command = value;
		else if (key === "label") out.label = value;
		else if (key === "auth") {
			if (value === "public" || value === "header" || value === "query" || value === "oauth-dcr" || value === "oauth-preregistered") {
				out.auth = { mode: value };
			} else {
				out.error = `unknown auth mode: ${value}`;
			}
		} else if (key.startsWith("header_")) {
			headers.push({ name: key.slice("header_".length), value });
		} else if (key === "api_key") {
			headers.push({ name: "Authorization", value: `Bearer ${value}` });
		}
	}
	if (headers.length > 0) {
		out.auth = out.auth ?? { mode: "header" };
		out.auth.headers = headers;
	}
	if (!out.url && !out.command) out.error = "expected url=<url> or command=<cmd>";
	return out;
}

/**
 * Headless slash-command handler — minimal `/mcp*` dispatcher used by the
 * cli-headless e2e bucket to drive MCP control-plane operations through
 * stdin without spinning up an interactive REPL.
 *
 * Each handled command writes a single `<command-response>…</command-response>`
 * block to stdout. Unhandled slashes return `null` so the caller can fall back
 * to treating the line as a chat prompt (matches the existing behaviour).
 */
async function tryHandleSlash(
	line: string,
	client: ReturnType<typeof createBodhiPiClient>,
	sessionId: string,
): Promise<string | null> {
	if (!line.startsWith("/")) return null;
	const parts = line.trim().split(/\s+/);
	const cmd = parts[0];
	if (cmd === "/mcps") {
		const entries = await client.mcpList();
		if (entries.length === 0) return "(no MCPs configured)";
		return entries
			.map((e) => `  ${e.slug}  ${e.status}  ${e.transport}  ${e.url ?? e.command ?? ""}`)
			.join("\n");
	}
	if (cmd === "/mcp") {
		const sub = parts[1];
		const rest = parts.slice(2);
		if (sub === "add") {
			const args = parseMcpAddArgs(rest);
			if (args.error) return `error: ${args.error}`;
			const result = args.url
				? await client.mcpAdd({
						url: args.url,
						...(args.auth ? { auth: args.auth } : {}),
						...(args.label ? { label: args.label } : {}),
					})
				: await client.mcpAdd({
						command: args.command as string,
						...(args.cmdArgs ? { args: args.cmdArgs } : {}),
						...(args.label ? { label: args.label } : {}),
					});
			return `added: ${result.slug}`;
		}
		const slug = rest[0];
		if (!sub || !slug) return "usage: /mcp <add|connect|disconnect|reconnect|remove|tools> [args…]";
		if (sub === "connect") {
			const result = await client.mcpConnect({ slug, sessionId });
			return `connected ${slug}: ${result.tools.join(", ") || "(no tools)"}`;
		}
		if (sub === "disconnect") {
			await client.mcpDisconnect({ slug, sessionId });
			return `disconnected ${slug}`;
		}
		if (sub === "reconnect") {
			const result = await client.mcpReconnect({ slug, sessionId });
			return `reconnected ${slug}: ${result.tools.join(", ") || "(no tools)"}`;
		}
		if (sub === "remove") {
			await client.mcpRemove({ slug, sessionId });
			return `removed ${slug}`;
		}
		if (sub === "tools") {
			const tools = await client.mcpTools({ slug, sessionId });
			if (tools.length === 0) return `(no tools — is ${slug} connected?)`;
			return tools.map((t) => `  ${t}`).join("\n");
		}
		return `unknown /mcp sub-command: ${sub}`;
	}
	return null;
}

export interface HeadlessOptions {
	factory: ReturnType<typeof createBodhiPiAgent>;
	cwd: string;
	sessionStore: SessionStore;
}

/**
 * Headless tagged-REPL mode. Each line on stdin is a user prompt; agent text
 * for that turn is emitted as a single `<response>…</response>` block on
 * stdout. No chalk, no decorations. Used by the cli-headless e2e bucket to
 * exercise user-facing chat without driving raw ACP frames.
 *
 * Slash commands are not interpreted locally — they are forwarded to the agent
 * as prompts. For built-in REPL commands like `/model`, drive the equivalent
 * via raw ACP in `--rpc` mode instead.
 */
export async function runHeadless(opts: HeadlessOptions): Promise<void> {
	const a2c = new TransformStream<AnyMessage, AnyMessage>();
	const c2a = new TransformStream<AnyMessage, AnyMessage>();
	const agentStream: Stream = { readable: c2a.readable, writable: a2c.writable };
	const clientStream: Stream = { readable: a2c.readable, writable: c2a.writable };

	const agentConn = new AgentSideConnection(opts.factory, agentStream);
	void agentConn;

	let turnText = "";
	const clientConn = new ClientSideConnection(
		(_agent: Agent): Client => ({
			sessionUpdate: async (params) => {
				const update = params.update as Record<string, unknown>;
				if (update.sessionUpdate === "agent_message_chunk") {
					const content = update.content as { type: string; text?: string };
					if (content?.type === "text" && content.text) turnText += content.text;
				}
			},
			requestPermission: async () => ({ outcome: { outcome: "approved" } }),
		}),
		clientStream,
	);

	await clientConn.initialize(INIT_PARAMS);
	const bodhiClient = createBodhiPiClient(clientConn, { cwd: opts.cwd });
	const created = await bodhiClient.newSession({ cwd: opts.cwd, mcpServers: [] });

	const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

	for await (const rawLine of rl) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			const slashResult = await tryHandleSlash(line, bodhiClient, created.sessionId);
			if (slashResult !== null) {
				process.stdout.write(`<command-response>\n${slashResult}\n</command-response>\n`);
				continue;
			}
		} catch (err) {
			process.stdout.write(`<command-response>\n[error] ${String(err)}\n</command-response>\n`);
			continue;
		}
		turnText = "";
		try {
			await bodhiClient.prompt(line, { sessionId: created.sessionId });
			process.stdout.write(`<response>\n${turnText}\n</response>\n`);
		} catch (err) {
			process.stdout.write(`<response>\n[error] ${String(err)}\n</response>\n`);
		}
	}

	rl.close();
	process.exit(0);
}
