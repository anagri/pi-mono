import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import type { KvStore } from "../kv/kv-store.js";
import { BODHI_PI_VERSION } from "../version.js";
import { resolveStdioEnv } from "./mcp-stdio-env.js";
import {
	MCP_PREFIX,
	type McpAuthConfig,
	type McpAuthMode,
	type McpServerEntry,
	type McpToolInfo,
	parseMcpServerEntry,
} from "./mcp-types.js";

const CLIENT_INFO = { name: "bodhi-pi", version: BODHI_PI_VERSION };
// MV3 chrome ext / other CSP-restricted runtimes forbid `new Function` (Ajv default).
const SCHEMA_VALIDATOR = new CfWorkerJsonSchemaValidator();

export interface ConnectedClient {
	client: Client;
	tools: McpToolInfo[];
	close(): Promise<void>;
}

export interface ConnectOptions {
	/** Invoked once when the underlying transport closes unexpectedly (network drop, server crash). Not fired on explicit close(). */
	onTransportClose?: () => void;
	/** When false, throws at the stdio branch rather than spawning. Defence in depth beyond `handleAdd`'s chokepoint. Defaults to true. */
	supportsStdio?: boolean;
	/** Required for `oauth-preregistered` entries: lets the attacher re-read the latest access token per request after a refresh writes back. */
	kvStore?: KvStore;
	/** Required for `oauth-preregistered` entries: identifies which `mcp/<slug>` kv key to re-read. */
	slug?: string;
}

export async function connectMcp(entry: McpServerEntry, opts: ConnectOptions = {}): Promise<ConnectedClient> {
	const client = new Client(CLIENT_INFO, { jsonSchemaValidator: SCHEMA_VALIDATOR });
	if (entry.transport === "http") {
		if (!entry.url) throw new Error("http MCP entry missing url");
		const transport = buildHttpTransport(entry.url, entry.auth, {
			...(opts.kvStore !== undefined ? { kvStore: opts.kvStore } : {}),
			...(opts.slug !== undefined ? { slug: opts.slug } : {}),
		});
		await client.connect(transport);
	} else {
		if (opts.supportsStdio === false) throw new Error("stdio MCP not supported on this runtime");
		if (!entry.command) throw new Error("stdio MCP entry missing command");
		// dynamic import keeps node:child_process out of browser bundles.
		const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
		const transport = new StdioClientTransport({
			command: entry.command,
			args: entry.args ?? [],
			env: resolveStdioEnv(entry.env),
		});
		await client.connect(transport);
	}
	const tools = await listTools(client);
	let closedExplicitly = false;
	if (opts.onTransportClose) {
		const cb = opts.onTransportClose;
		client.onclose = () => {
			if (closedExplicitly) return;
			cb();
		};
	}
	return {
		client,
		tools,
		close: async () => {
			closedExplicitly = true;
			try {
				await client.close();
			} catch {
				// best-effort
			}
		},
	};
}

export interface BuildHttpTransportOptions {
	kvStore?: KvStore;
	slug?: string;
}

interface AttachContext {
	kvStore?: KvStore;
	slug?: string;
}

interface TransportOpts {
	requestInit?: RequestInit;
	fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

type AuthAttacher = (url: URL, opts: TransportOpts, auth: McpAuthConfig, ctx: AttachContext) => void;

const ATTACHERS: Record<McpAuthMode, AuthAttacher> = {
	public: () => {},
	"http-param": (url, opts, auth) => {
		if (auth.mode !== "http-param") return;
		if (auth.queries) {
			for (const q of auth.queries) url.searchParams.append(q.name, q.value);
		}
		if (auth.headers && auth.headers.length > 0) {
			const headers: Record<string, string> = {};
			for (const h of auth.headers) headers[h.name] = h.value;
			opts.requestInit = { headers };
		}
	},
	"oauth-preregistered": (_url, opts, auth, ctx) => {
		if (auth.mode !== "oauth-preregistered") return;
		if (!ctx.kvStore || !ctx.slug) {
			throw new Error("oauth-preregistered transport requires kvStore + slug in ConnectOptions");
		}
		// SDK exposes `opts.fetch` (top-level) which wraps every outbound request. We re-read the
		// latest access token from kv per call so a refresh elsewhere writes new tokens back to
		// `mcp/<slug>` and the next request picks them up — no transport rebuild required.
		const kvStore = ctx.kvStore;
		const slug = ctx.slug;
		opts.fetch = async (url, init) => {
			const headers = new Headers(init?.headers);
			const raw = await kvStore.get(`${MCP_PREFIX}${slug}`);
			const entry = parseMcpServerEntry(raw ?? null);
			if (entry && entry.auth.mode === "oauth-preregistered" && entry.auth.tokens) {
				const tokenType = entry.auth.tokens.tokenType ?? "Bearer";
				headers.set("Authorization", `${tokenType} ${entry.auth.tokens.access.value}`);
			}
			return fetch(url, { ...init, headers });
		};
	},
};

/**
 * Build the SDK transport for an http-streamable MCP server. Dispatch on `auth.mode` to the
 * matching attacher in the strategy table — `public` is a no-op, `http-param` snapshots headers
 * and queries at connect time, `oauth-preregistered` installs a per-request closure that re-reads
 * the access token from kv. Adding a new auth mode means adding one entry to the `ATTACHERS`
 * table and one branch in `parseAuthInput`.
 */
export function buildHttpTransport(
	rawUrl: string,
	auth: McpAuthConfig,
	buildOpts: BuildHttpTransportOptions = {},
): StreamableHTTPClientTransport {
	const url = new URL(rawUrl);
	const opts: TransportOpts = {};
	const attacher = ATTACHERS[auth.mode];
	attacher(url, opts, auth, buildOpts);
	return new StreamableHTTPClientTransport(
		url,
		opts as ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
	);
}

async function listTools(client: Client): Promise<McpToolInfo[]> {
	const res = await client.listTools();
	const list: McpToolInfo[] = [];
	for (const t of res.tools ?? []) {
		const tool: McpToolInfo = { name: t.name };
		if (typeof t.description === "string") tool.description = t.description;
		if (t.inputSchema) tool.inputSchema = t.inputSchema as unknown as McpToolInfo["inputSchema"];
		list.push(tool);
	}
	return list;
}

export async function callMcpTool(
	client: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<{ content: unknown; isError: boolean }> {
	const result = await client.callTool({ name, arguments: args });
	const content = result.content as unknown;
	const isError = result.isError === true;
	return { content, isError };
}
