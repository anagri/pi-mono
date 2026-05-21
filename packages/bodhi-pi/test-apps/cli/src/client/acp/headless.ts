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
	LIFECYCLE_EVENT_METHOD,
	parseMcpAddArgs,
	type SessionStore,
} from "@bodhiapp/bodhi-pi";
// seam-exception: slash command (client) starts the OAuth redirect server (host) — single-process flow, redirect_uri lives in the start request.
import { startOAuthCallbackServer } from "../../host/oauth-callback-server.js";

const INIT_PARAMS = {
	protocolVersion: 1,
	clientCapabilities: {
		fs: { readTextFile: false, writeTextFile: false },
		terminal: false,
	},
} as const;

interface SessionRegistry {
	active: string;
	all: string[];
}

interface OAuthListenerEntry {
	resolve: (outcome: { status: string; errorMessage?: string }) => void;
}

const oauthListeners = new Map<string, OAuthListenerEntry>();

/** Port the cli host binds for OAuth redirects. Override per-flow by passing `--port=NNNN` on `/mcp oauth start`. */
const DEFAULT_OAUTH_CALLBACK_PORT = 7777;

async function tryHandleSlash(
	line: string,
	client: ReturnType<typeof createBodhiPiClient>,
	cwd: string,
	registry: SessionRegistry,
): Promise<string | null> {
	if (!line.startsWith("/")) return null;
	const parts = line.trim().split(/\s+/);
	const cmd = parts[0];
	const sessionId = registry.active;

	if (cmd === "/session") {
		const sub = parts[1];
		if (sub === "new") {
			const created = await client.newSession({ cwd });
			registry.all.push(created.sessionId);
			registry.active = created.sessionId;
			return `session ${created.sessionId} (active)`;
		}
		if (sub === "switch") {
			const target = parts[2];
			if (!target) return "usage: /session switch <sessionId>";
			if (!registry.all.includes(target)) return `unknown session: ${target}`;
			registry.active = target;
			return `active session: ${target}`;
		}
		if (sub === "list") {
			return registry.all.map((sid) => `${sid === registry.active ? "*" : " "} ${sid}`).join("\n");
		}
		return "usage: /session <new|switch <id>|list>";
	}

	if (cmd === "/mcps") {
		const entries = await client.mcpList();
		if (entries.length === 0) return "(no MCPs configured)";
		return entries
			.map((e) => `  ${e.slug}  ${e.status}  ${e.transport}  ${e.url ?? e.command ?? ""}`)
			.join("\n");
	}

	if (cmd === "/agents") {
		const res = await client.listSubagents({ sessionId });
		if (res.profiles.length === 0) return "(no sub-agent profiles in .bodhi-pi/agents/)";
		return ["agents:", ...res.profiles.map((p) => `  ${p.name}  ${p.description}`)].join("\n");
	}

	if (cmd === "/subagent") {
		const sub = parts[1];
		if (sub === "children") {
			const res = await client.subagentChildren({ sessionId });
			if (res.children.length === 0) return "(no sub-agent runs from this session)";
			return [
				"sub-agent runs:",
				...res.children.map((c) => `  ${c.sessionId}  ${c.subagent?.profileName ?? "(unknown)"}`),
			].join("\n");
		}
		const agent = parts[1];
		if (!agent || parts.length < 3) {
			return "usage: /subagent <name> <task...>  |  /subagent children";
		}
		const task = line.trim().slice(`/subagent ${agent} `.length);
		const res = await client.runSubagent({ sessionId, agent, task });
		const lines = [
			`sub-agent ${agent}: ${res.status} (${res.durationMs}ms, ${res.toolCount} tool calls)`,
			`childSessionId: ${res.childSessionId}`,
		];
		if (res.summary) lines.push("", res.summary);
		if (res.error) lines.push("", `error: ${res.error}`);
		return lines.join("\n");
	}

	if (cmd === "/mcp") {
		const sub = parts[1];
		const rest = parts.slice(2);
		if (sub === "add") {
			const args = parseMcpAddArgs(rest);
			if (args.error || !args.value) return `error: ${args.error ?? "missing argument"}`;
			const result = await client.mcpAdd(args.value as Parameters<typeof client.mcpAdd>[0]);
			return `added: ${result.slug}`;
		}
		if (sub === "oauth") {
			return await handleOauthSlash(client, rest);
		}
		const slug = rest[0];
		if (!sub || !slug) {
			return "usage: /mcp <add|connect|disconnect|reconnect|remove|include|exclude|tools> [args…]";
		}
		if (sub === "connect") {
			const result = await client.mcpConnect({ slug });
			return `connected ${slug}: ${result.tools.join(", ") || "(no tools)"}`;
		}
		if (sub === "disconnect") {
			await client.mcpDisconnect({ slug });
			return `disconnected ${slug}`;
		}
		if (sub === "reconnect") {
			const result = await client.mcpReconnect({ slug });
			return `reconnected ${slug}: ${result.tools.join(", ") || "(no tools)"}`;
		}
		if (sub === "remove") {
			await client.mcpRemove({ slug });
			return `removed ${slug}`;
		}
		if (sub === "include") {
			const result = await client.mcpInclude({ slug, sessionId });
			return `included ${slug}: ${result.tools.join(", ") || "(no tools visible)"}`;
		}
		if (sub === "exclude") {
			await client.mcpExclude({ slug, sessionId });
			return `excluded ${slug}`;
		}
		if (sub === "tools") {
			const tools = await client.mcpTools({ slug, sessionId });
			if (tools.length === 0) return `(no tools — is ${slug} connected and included?)`;
			return tools.map((t) => `  ${t}`).join("\n");
		}
		return `unknown /mcp sub-command: ${sub}`;
	}
	return null;
}

async function handleOauthSlash(
	client: ReturnType<typeof createBodhiPiClient>,
	args: string[],
): Promise<string> {
	const action = args[0];
	if (action === "discover") {
		const url = args[1];
		if (!url) return "usage: /mcp oauth discover <mcp-url>";
		const result = await client.mcpOauthDiscover({ url });
		const lines = [`oauth-discover: authorizationServer=${result.authorizationServerUrl}`];
		if (result.authorizeUrl) lines.push(`  authorize: ${result.authorizeUrl}`);
		if (result.tokenUrl) lines.push(`  token:     ${result.tokenUrl}`);
		if (result.registrationEndpoint) lines.push(`  register:  ${result.registrationEndpoint}`);
		if (result.scopesSupported) lines.push(`  scopes:    ${result.scopesSupported.join(" ")}`);
		if (result.resource) lines.push(`  resource:  ${result.resource}`);
		return lines.join("\n");
	}
	if (action === "register") {
		const registrationEndpoint = args[1];
		const redirectUri = args[2];
		if (!registrationEndpoint || !redirectUri) {
			return "usage: /mcp oauth register <registration-endpoint> <redirect-uri> [--scopes=a,b]";
		}
		const flags = parseFlags(args.slice(3));
		const scopes = typeof flags.scopes === "string" ? flags.scopes.split(",") : undefined;
		const result = await client.mcpOauthRegister({
			registrationEndpoint,
			redirectUri,
			...(scopes ? { scopes } : {}),
		});
		const lines = [
			`oauth-register: clientId=${result.clientId}`,
			`  clientSecret: ${result.clientSecret ? `<set, ${result.clientSecret.length} chars>` : "(none — public client)"}`,
		];
		if (result.tokenEndpointAuthMethod) lines.push(`  authMethod:   ${result.tokenEndpointAuthMethod}`);
		return lines.join("\n");
	}
	if (action !== "start" && action !== "cancel") {
		return "usage: /mcp oauth <discover <url>|register <regUrl> <redirectUri>|start <slug>|cancel <slug>>";
	}
	const slug = args[1];
	if (!slug) return `usage: /mcp oauth ${action} <slug>`;
	const flags = parseFlags(args.slice(2));
	const port = typeof flags.port === "string" ? Number(flags.port) : DEFAULT_OAUTH_CALLBACK_PORT;
	if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
		return `error: invalid --port=${flags.port}`;
	}

	if (action === "cancel") {
		const state = typeof flags.state === "string" ? flags.state : undefined;
		if (!state) return "usage: /mcp oauth cancel <slug> --state=<state>";
		await client.mcpOauthCancel({ slug, state });
		return `oauth: cancelled ${slug}`;
	}

	// action === "start" — register listener BEFORE calling oauth/start so we don't race the event.
	const completion = new Promise<{ status: string; errorMessage?: string }>((resolve) => {
		oauthListeners.set(slug, { resolve });
	});

	const server = await startOAuthCallbackServer({
		port,
		onCallback: async ({ code, state }) => {
			try {
				await client.mcpOauthFinish({ slug, code, state });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const listener = oauthListeners.get(slug);
				if (listener) {
					oauthListeners.delete(slug);
					listener.resolve({ status: "failed", errorMessage: message });
				}
			}
		},
		onTimeout: () => {
			const listener = oauthListeners.get(slug);
			if (listener) {
				oauthListeners.delete(slug);
				listener.resolve({ status: "failed", errorMessage: "callback timeout" });
			}
		},
	});

	try {
		const start = await client.mcpOauthStart({ slug, redirectUri: server.redirectUri });
		if (start.status === "completed") {
			oauthListeners.delete(slug);
			await server.close();
			return `oauth: already authorized for ${slug}`;
		}
		const authorizeUrl = start.authorizeUrl!;
		const lines: string[] = [`oauth: open this URL to authenticate ${slug}:`, authorizeUrl];
		if (flags.auto) {
			// Test-only convenience: fetch the URL ourselves (the fixture's `?auto=1` query bypasses
			// the approve page). Fires the redirect → our callback server → mcpOauthFinish.
			const u = new URL(authorizeUrl);
			u.searchParams.set("auto", "1");
			void fetch(u.toString()).catch(() => {
				// best-effort; the lifecycle event listener will time out and surface failure.
			});
		}
		const outcome = await completion;
		if (outcome.status === "completed") {
			lines.push("oauth: completed");
		} else {
			lines.push(`oauth: failed: ${outcome.errorMessage ?? "unknown"}`);
		}
		return lines.join("\n");
	} catch (err) {
		oauthListeners.delete(slug);
		await server.close();
		throw err;
	}
}

function parseFlags(tokens: string[]): { auto?: boolean; port?: string; state?: string; scopes?: string } {
	const out: { auto?: boolean; port?: string; state?: string; scopes?: string } = {};
	for (const t of tokens) {
		if (t === "--auto") out.auto = true;
		else if (t.startsWith("--port=")) out.port = t.slice("--port=".length);
		else if (t.startsWith("--state=")) out.state = t.slice("--state=".length);
		else if (t.startsWith("--scopes=")) out.scopes = t.slice("--scopes=".length);
	}
	return out;
}

export interface HeadlessOptions {
	factory: ReturnType<typeof createBodhiPiAgent>;
	cwd: string;
	sessionStore: SessionStore;
}

/**
 * Headless tagged-REPL mode. Each line on stdin is a user prompt; agent text
 * for that turn is emitted as a single `<response>…</response>` block on
 * stdout. Slash commands matching `/mcp*`, `/mcps`, `/session*` are handled
 * locally and emit `<command-response>…</command-response>` blocks instead.
 * Other slashes are forwarded to the agent as prompts.
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
			extNotification: async (method, params) => {
				if (method !== LIFECYCLE_EVENT_METHOD) return;
				const event = params as { type?: string; slug?: string; status?: string; errorMessage?: string };
				if (event?.type !== "mcp_oauth_status_change") return;
				if (event.status !== "completed" && event.status !== "failed") return;
				const slug = event.slug;
				if (!slug) return;
				const listener = oauthListeners.get(slug);
				if (!listener) return;
				oauthListeners.delete(slug);
				listener.resolve({
					status: event.status,
					...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
				});
			},
		}),
		clientStream,
	);

	await clientConn.initialize(INIT_PARAMS);
	const bodhiClient = createBodhiPiClient(clientConn, { cwd: opts.cwd });
	const created = await bodhiClient.newSession({ cwd: opts.cwd });
	const registry: SessionRegistry = { active: created.sessionId, all: [created.sessionId] };

	const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

	for await (const rawLine of rl) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			const slashResult = await tryHandleSlash(line, bodhiClient, opts.cwd, registry);
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
			await bodhiClient.prompt(line, { sessionId: registry.active });
			process.stdout.write(`<response>\n${turnText}\n</response>\n`);
		} catch (err) {
			process.stdout.write(`<response>\n[error] ${String(err)}\n</response>\n`);
		}
	}

	rl.close();
	process.exit(0);
}
