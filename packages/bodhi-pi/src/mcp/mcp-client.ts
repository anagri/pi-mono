import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import type { KvStore } from "../kv/kv-store.js";
import { BODHI_PI_VERSION } from "../version.js";
import { makeRefreshOauthProvider, runAuthFlow } from "./mcp-oauth-provider.js";
import { resolveStdioEnv } from "./mcp-stdio-env.js";
import {
	MCP_PREFIX,
	type McpAuthConfig,
	type McpAuthMode,
	type McpAuthOAuthConfig,
	type McpServerEntry,
	type McpToolInfo,
	parseMcpServerEntry,
} from "./mcp-types.js";

async function refreshOauthTokens(kvStore: KvStore, slug: string, cfg: McpAuthOAuthConfig): Promise<void> {
	await runAuthFlow(makeRefreshOauthProvider(kvStore, slug, cfg), cfg.tokenUrl);
}

const CLIENT_INFO = { name: "bodhi-pi", version: BODHI_PI_VERSION };
// MV3 chrome-ext / CSP-restricted runtimes forbid `new Function` (Ajv default)
const SCHEMA_VALIDATOR = new CfWorkerJsonSchemaValidator();

export interface ConnectedClient {
	client: Client;
	tools: McpToolInfo[];
	close(): Promise<void>;
}

export interface ConnectOptions {
	onTransportClose?: () => void;
	supportsStdio?: boolean;
	kvStore?: KvStore;
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
		// dynamic import keeps node:child_process out of browser bundles
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
			} catch {}
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
	oauth: (_url, opts, auth, ctx) => {
		if (auth.mode !== "oauth") return;
		if (!ctx.kvStore || !ctx.slug) {
			throw new Error("oauth transport requires kvStore + slug in ConnectOptions");
		}
		const kvStore = ctx.kvStore;
		const slug = ctx.slug;
		const REFRESH_SLACK_MS = 60_000;
		// single-flight refresh: refresh_token is single-use, parallel refresh would burn it
		let inFlightRefresh: Promise<void> | null = null;
		const readEntry = async (): Promise<McpServerEntry | null> => {
			const raw = await kvStore.get(`${MCP_PREFIX}${slug}`);
			return parseMcpServerEntry(raw ?? null);
		};
		const setBearerFromEntry = (entry: McpServerEntry | null, headers: Headers): void => {
			if (entry && entry.auth.mode === "oauth" && entry.auth.tokens) {
				// RFC 6750 §2.1 fixes scheme as "Bearer"; some providers (Linear) return lowercase token_type
				headers.set("Authorization", `Bearer ${entry.auth.tokens.access.value}`);
			}
		};
		const doRefresh = async (cfg: McpAuthOAuthConfig): Promise<void> => {
			if (!inFlightRefresh) {
				inFlightRefresh = refreshOauthTokens(kvStore, slug, cfg).finally(() => {
					inFlightRefresh = null;
				});
			}
			await inFlightRefresh;
		};
		opts.fetch = async (url, init) => {
			let entry = await readEntry();
			if (
				entry &&
				entry.auth.mode === "oauth" &&
				entry.auth.tokens?.expiresAt !== undefined &&
				entry.auth.tokens.refresh &&
				entry.auth.tokens.expiresAt - REFRESH_SLACK_MS < Date.now()
			) {
				try {
					await doRefresh(entry.auth);
					entry = await readEntry();
				} catch {}
			}
			const headers = new Headers(init?.headers);
			setBearerFromEntry(entry, headers);
			let response = await fetch(url, { ...init, headers });
			if (response.status === 401 && entry && entry.auth.mode === "oauth" && entry.auth.tokens?.refresh) {
				try {
					await doRefresh(entry.auth);
					const refreshed = await readEntry();
					if (refreshed && refreshed.auth.mode === "oauth" && refreshed.auth.tokens) {
						const retryHeaders = new Headers(init?.headers);
						setBearerFromEntry(refreshed, retryHeaders);
						response = await fetch(url, { ...init, headers: retryHeaders });
					}
				} catch {}
			}
			return response;
		};
	},
};

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
