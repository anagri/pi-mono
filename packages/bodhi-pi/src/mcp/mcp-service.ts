import { RequestError } from "@agentclientprotocol/sdk";
import { discoverOAuthServerInfo, registerClient } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { BodhiPiLogger } from "../acp/agent.js";
import type { EventDispatcher } from "../events/dispatcher.js";
import { type KvStore, maskSecrets } from "../kv/kv-store.js";
import type { AppendEntry } from "../models/registry.js";
import type { SessionState } from "../sessions/session-state.js";
import {
	EXT_MCP_ADD,
	EXT_MCP_CONNECT,
	EXT_MCP_DISCONNECT,
	EXT_MCP_EXCLUDE,
	EXT_MCP_INCLUDE,
	EXT_MCP_LIST,
	EXT_MCP_OAUTH_CANCEL,
	EXT_MCP_OAUTH_DISCOVER,
	EXT_MCP_OAUTH_FINISH,
	EXT_MCP_OAUTH_REGISTER,
	EXT_MCP_OAUTH_START,
	EXT_MCP_RECONNECT,
	EXT_MCP_REMOVE,
	EXT_MCP_TOOLS,
} from "../wire/constants.js";
import { requireStringParam, validateSessionId } from "../wire/validators.js";
import { McpConnectionLifecycle } from "./mcp-connection-lifecycle.js";
import type { McpConnectionProvider } from "./mcp-connection-provider.js";
import { KvOAuthProvider, runAuthFlow } from "./mcp-oauth-provider.js";
import { OAuthStateKv } from "./mcp-oauth-state-kv.js";
import { McpRegistry } from "./mcp-registry.js";
import { resolveUniqueSlug, slugifyCommand, slugifyUrl } from "./mcp-slug.js";
import { McpStore } from "./mcp-store.js";
import {
	MCP_PREFIX,
	type McpAuthConfig,
	type McpAuthHttpParamConfig,
	type McpAuthOAuthConfig,
	type McpDcrInfo,
	type McpListEntry,
	type McpNamedSecret,
	type McpServerEntry,
	parseMcpServerEntry,
	serializeAuthConfig,
	serializeMcpServerEntry,
} from "./mcp-types.js";

type ExtHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface McpServiceDeps {
	kvStore?: KvStore;
	events: EventDispatcher;
	sessions: Map<string, SessionState>;
	logger: BodhiPiLogger;
	supportsStdio?: boolean;
	provider: McpConnectionProvider;
	appendEntry: AppendEntry;
	/**
	 * Multi-tenant routing token used by oauth state generation. When set, the
	 * `state` parameter sent to the authorization server is prefixed with `base64url(tenantId).`,
	 * letting a process-wide `/oauth/callback` route the redirect to the right user's kvStore
	 * without holding extra state. Single-tenant hosts (CLI, in-memory) leave this undefined.
	 */
	tenantId?: string;
}

export class McpService {
	private readonly store: McpStore;
	private readonly lifecycle: McpConnectionLifecycle;
	private readonly registry: McpRegistry;
	private readonly provider: McpConnectionProvider;
	private readonly supportsStdio: boolean;
	private readonly tenantId: string | undefined;

	constructor(deps: McpServiceDeps) {
		this.supportsStdio = deps.supportsStdio ?? true;
		this.provider = deps.provider;
		this.tenantId = deps.tenantId;
		this.store = new McpStore({
			kvStore: deps.kvStore,
			sessions: deps.sessions,
			appendEntry: deps.appendEntry,
		});
		this.registry = new McpRegistry(deps.sessions, deps.provider);
		this.lifecycle = new McpConnectionLifecycle({
			events: deps.events,
			sessions: deps.sessions,
			provider: deps.provider,
			logger: deps.logger,
			store: this.store,
			registry: this.registry,
		});
		// Host's provider mutates its connection map → refresh piAgent.state.tools for every loaded session.
		this.provider.onChange(() => this.registry.applyToAllSessions());
	}

	register(): Array<[string, ExtHandler]> {
		return [
			[EXT_MCP_ADD, this.handleAdd.bind(this)],
			[EXT_MCP_REMOVE, this.handleRemove.bind(this)],
			[EXT_MCP_CONNECT, this.handleConnect.bind(this)],
			[EXT_MCP_DISCONNECT, this.handleDisconnect.bind(this)],
			[EXT_MCP_RECONNECT, this.handleReconnect.bind(this)],
			[EXT_MCP_LIST, this.handleList.bind(this)],
			[EXT_MCP_TOOLS, this.handleTools.bind(this)],
			[EXT_MCP_INCLUDE, this.handleInclude.bind(this)],
			[EXT_MCP_EXCLUDE, this.handleExclude.bind(this)],
			[EXT_MCP_OAUTH_START, this.handleOauthStart.bind(this)],
			[EXT_MCP_OAUTH_FINISH, this.handleOauthFinish.bind(this)],
			[EXT_MCP_OAUTH_CANCEL, this.handleOauthCancel.bind(this)],
			[EXT_MCP_OAUTH_DISCOVER, this.handleOauthDiscover.bind(this)],
			[EXT_MCP_OAUTH_REGISTER, this.handleOauthRegister.bind(this)],
		];
	}

	hydrate(
		sessionId: string,
		ephemeral: Parameters<McpConnectionLifecycle["hydrate"]>[1],
		restoredSlugs: string[] | null,
	): Promise<{ notFoundSlugs: string[] }> {
		return this.lifecycle.hydrate(sessionId, ephemeral, restoredSlugs);
	}

	closeSession(sessionId: string): void {
		this.lifecycle.closeSession(sessionId);
	}

	private async handleAdd(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_ADD);
		const url = typeof params.url === "string" ? params.url : undefined;
		const command = typeof params.command === "string" ? params.command : undefined;
		if (!url && !command) {
			throw new RequestError(-32602, `${EXT_MCP_ADD}: either url or command is required`);
		}
		if (command && !this.supportsStdio) {
			throw new RequestError(-32601, `${EXT_MCP_ADD}: stdio MCPs are not supported on this runtime`);
		}
		const transport: "http" | "stdio" = url ? "http" : "stdio";
		const args = parseStringArray(params.args, `${EXT_MCP_ADD}: args`);
		const env = parseNamedSecretListParam(params.env);
		const label = typeof params.label === "string" && params.label.length > 0 ? params.label : undefined;
		// oauth-dcr is async (network: discovery + DCR); all other branches are sync validation.
		const auth: McpAuthConfig =
			params.auth === "oauth-dcr" ? await runDcrAddFlow(params, transport) : parseAuthInput(params, transport);
		const candidate = transport === "http" ? slugifyUrl(url ?? "") : slugifyCommand(command ?? "", args);
		const slug = await resolveUniqueSlug(candidate, kv);
		const entry: McpServerEntry = {
			transport,
			auth,
			label: label ?? slug,
			addedAt: new Date().toISOString(),
			lastKnownStatus: "disconnected",
		};
		if (url) entry.url = url;
		if (command) entry.command = command;
		if (args.length > 0) entry.args = args;
		if (env.length > 0) entry.env = env;
		await kv.set(`${MCP_PREFIX}${slug}`, serializeMcpServerEntry(entry));
		return { slug };
	}

	private async handleRemove(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_REMOVE);
		const slug = requireStringParam(EXT_MCP_REMOVE, params, "slug");
		await this.provider.disconnect(slug);
		await kv.remove(`${MCP_PREFIX}${slug}`);
		await this.lifecycle.emitStatusBroadcast(slug, "disconnected");
		return { slug };
	}

	private async handleConnect(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_CONNECT);
		const slug = requireStringParam(EXT_MCP_CONNECT, params, "slug");
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (!entry) throw new RequestError(-32602, `${EXT_MCP_CONNECT}: unknown mcp ${slug}`);
		if (this.provider.isConnected(slug)) {
			return { tools: this.provider.getToolNames(slug) ?? [] };
		}
		const result = await this.lifecycle.tryProviderConnect(slug, entry);
		await this.store.persistStatus(slug, entry, "connected");
		await this.lifecycle.emitStatusBroadcast(slug, "connected");
		await this.lifecycle.emitToolsBroadcast(slug, result.toolNames);
		return { tools: result.toolNames };
	}

	private async handleDisconnect(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_DISCONNECT);
		const slug = requireStringParam(EXT_MCP_DISCONNECT, params, "slug");
		await this.provider.disconnect(slug);
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (entry) await this.store.persistStatus(slug, entry, "disconnected");
		await this.lifecycle.emitStatusBroadcast(slug, "disconnected");
		return { slug };
	}

	private async handleReconnect(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_RECONNECT);
		const slug = requireStringParam(EXT_MCP_RECONNECT, params, "slug");
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (!entry) throw new RequestError(-32602, `${EXT_MCP_RECONNECT}: unknown mcp ${slug}`);
		const result = await this.lifecycle.tryProviderReconnect(slug, entry);
		await this.store.persistStatus(slug, entry, "connected");
		await this.lifecycle.emitStatusBroadcast(slug, "connected");
		await this.lifecycle.emitToolsBroadcast(slug, result.toolNames);
		return { tools: result.toolNames };
	}

	private async handleList(_params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_LIST);
		const entries = await kv.list(MCP_PREFIX);
		const out: McpListEntry[] = [];
		for (const e of entries) {
			const entry = parseMcpServerEntry(e.value);
			if (!entry) continue;
			const slug = e.key.slice(MCP_PREFIX.length);
			const liveStatus = this.provider.isConnected(slug) ? "connected" : entry.lastKnownStatus;
			// Per spec: list response carries the auth blob with secret values left tagged
			// `{value, secret: true}`. The KV/ACP boundary masks values to `***` via `maskSecrets`;
			// callers reading this response over ACP see masked values, in-process callers see plaintext.
			const item: McpListEntry = {
				slug,
				label: entry.label,
				transport: entry.transport,
				status: liveStatus,
				auth: maskSecrets(serializeAuthConfig(entry.auth)),
			};
			if (entry.url !== undefined) item.url = entry.url;
			if (entry.command !== undefined) item.command = entry.command;
			out.push(item);
		}
		return { entries: out as unknown as Record<string, unknown>[] };
	}

	private async handleTools(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const slug = requireStringParam(EXT_MCP_TOOLS, params, "slug");
		const sessionId = validateSessionId(EXT_MCP_TOOLS, params);
		return { tools: this.registry.getVisibleToolNames(sessionId, slug) };
	}

	private async handleInclude(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_INCLUDE);
		const slug = requireStringParam(EXT_MCP_INCLUDE, params, "slug");
		const sessionId = validateSessionId(EXT_MCP_INCLUDE, params);
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (!entry) throw new RequestError(-32602, `${EXT_MCP_INCLUDE}: unknown mcp ${slug}`);
		this.registry.addInclusion(sessionId, slug);
		await this.store.persistInclusion(sessionId, this.registry.getInclusion(sessionId));
		return { slug, tools: this.provider.isConnected(slug) ? (this.provider.getToolNames(slug) ?? []) : [] };
	}

	private async handleExclude(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const slug = requireStringParam(EXT_MCP_EXCLUDE, params, "slug");
		const sessionId = validateSessionId(EXT_MCP_EXCLUDE, params);
		this.registry.removeInclusion(sessionId, slug);
		await this.store.persistInclusion(sessionId, this.registry.getInclusion(sessionId));
		return { slug };
	}

	private async handleOauthStart(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_OAUTH_START);
		const slug = requireStringParam(EXT_MCP_OAUTH_START, params, "slug");
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (!entry) throw new RequestError(-32602, `${EXT_MCP_OAUTH_START}: unknown mcp ${slug}`);
		if (entry.auth.mode !== "oauth") {
			throw new RequestError(-32602, `${EXT_MCP_OAUTH_START}: ${slug} is not configured for oauth`);
		}
		const paramRedirectUri = typeof params.redirectUri === "string" ? params.redirectUri : undefined;
		const redirectUri = paramRedirectUri ?? entry.auth.redirectUri;
		if (!redirectUri) {
			throw new RequestError(
				-32602,
				`${EXT_MCP_OAUTH_START}: redirect_uri required (pass on /mcp add or oauth/start)`,
			);
		}
		const stateKv = new OAuthStateKv(kv);
		const state = makeStateToken(this.tenantId);
		const provider = new KvOAuthProvider({
			kvStore: kv,
			slug,
			cfg: entry.auth,
			redirectUri,
			stateKv,
			state,
		});
		const result = await runAuthFlow(provider, entry.auth.tokenUrl);
		if (result.authorized) {
			await this.lifecycle.emitOauthStatusBroadcast(slug, "completed");
			return { status: "completed" };
		}
		await this.lifecycle.emitOauthStatusBroadcast(slug, "started");
		return { authorizeUrl: result.authorizeUrl, state };
	}

	private async handleOauthFinish(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_OAUTH_FINISH);
		const slug = requireStringParam(EXT_MCP_OAUTH_FINISH, params, "slug");
		const code = requireStringParam(EXT_MCP_OAUTH_FINISH, params, "code");
		const state = requireStringParam(EXT_MCP_OAUTH_FINISH, params, "state");
		const stateKv = new OAuthStateKv(kv);
		const stateEntry = await stateKv.get(state);
		if (!stateEntry || stateEntry.slug !== slug) {
			throw new RequestError(-32602, `${EXT_MCP_OAUTH_FINISH}: invalid or expired state`);
		}
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (!entry || entry.auth.mode !== "oauth") {
			throw new RequestError(-32602, `${EXT_MCP_OAUTH_FINISH}: ${slug} is not configured for oauth`);
		}
		const provider = new KvOAuthProvider({
			kvStore: kv,
			slug,
			cfg: entry.auth,
			redirectUri: stateEntry.redirectUri,
			stateKv,
			state,
		});
		try {
			await runAuthFlow(provider, entry.auth.tokenUrl, code);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await stateKv.remove(state);
			await this.lifecycle.emitOauthStatusBroadcast(slug, "failed", message);
			return { status: "failed", errorMessage: message };
		}
		await stateKv.remove(state);
		await this.lifecycle.emitOauthStatusBroadcast(slug, "completed");
		return { status: "completed" };
	}

	private async handleOauthCancel(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_OAUTH_CANCEL);
		const slug = requireStringParam(EXT_MCP_OAUTH_CANCEL, params, "slug");
		const state = requireStringParam(EXT_MCP_OAUTH_CANCEL, params, "state");
		const stateKv = new OAuthStateKv(kv);
		await stateKv.remove(state);
		await this.lifecycle.emitOauthStatusBroadcast(slug, "cancelled");
		return { ok: true };
	}

	private async handleOauthDiscover(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const url = requireStringParam(EXT_MCP_OAUTH_DISCOVER, params, "url");
		const info = await discoverOAuthServerInfo(url).catch((err) => {
			throw new RequestError(
				-32603,
				`${EXT_MCP_OAUTH_DISCOVER}: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
		const md = info.authorizationServerMetadata;
		const out: Record<string, unknown> = {
			authorizationServerUrl: info.authorizationServerUrl,
		};
		if (md?.authorization_endpoint) out.authorizeUrl = md.authorization_endpoint;
		if (md?.token_endpoint) out.tokenUrl = md.token_endpoint;
		if (md?.registration_endpoint) out.registrationEndpoint = md.registration_endpoint;
		if (md?.scopes_supported) out.scopesSupported = md.scopes_supported;
		if (info.resourceMetadata?.resource) out.resource = info.resourceMetadata.resource;
		return out;
	}

	private async handleOauthRegister(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const registrationEndpoint = requireStringParam(EXT_MCP_OAUTH_REGISTER, params, "registrationEndpoint");
		const redirectUri = requireStringParam(EXT_MCP_OAUTH_REGISTER, params, "redirectUri");
		const scopes = params.scopes;
		const clientName = typeof params.clientName === "string" ? params.clientName : "bodhi-pi";
		const clientUri = typeof params.clientUri === "string" ? params.clientUri : undefined;
		let scope: string | undefined;
		if (scopes !== undefined) {
			if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string")) {
				throw new RequestError(-32602, `${EXT_MCP_OAUTH_REGISTER}: scopes must be a string[]`);
			}
			scope = (scopes as string[]).join(" ");
		}
		const clientMetadata: OAuthClientMetadata = {
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			client_name: clientName,
			token_endpoint_auth_method: "client_secret_basic",
		};
		if (scope) clientMetadata.scope = scope;
		if (clientUri) clientMetadata.client_uri = clientUri as `https://${string}` | `http://${string}`;
		// Use the registration_endpoint URL as the authorization server URL — registerClient ignores
		// it except for error messages when metadata is absent (which it is here, by design).
		const registered = await registerClient(registrationEndpoint, {
			metadata: { registration_endpoint: registrationEndpoint } as Parameters<typeof registerClient>[1]["metadata"],
			clientMetadata,
			...(scope !== undefined ? { scope } : {}),
		}).catch((err) => {
			throw new RequestError(
				-32603,
				`${EXT_MCP_OAUTH_REGISTER}: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
		const out: Record<string, unknown> = { clientId: registered.client_id };
		if (registered.client_secret) out.clientSecret = registered.client_secret;
		if (registered.client_id_issued_at) out.clientIdIssuedAt = registered.client_id_issued_at;
		if (registered.token_endpoint_auth_method) out.tokenEndpointAuthMethod = registered.token_endpoint_auth_method;
		const ratField = (registered as { registration_access_token?: string }).registration_access_token;
		if (ratField) out.registrationAccessToken = ratField;
		return out;
	}
}

/**
 * Combined discovery + DCR flow for `auth: "oauth-dcr"` on `/mcp add`. Runs RFC 9728 + 8414
 * discovery on the MCP server's `url` (unless the user supplied all of authorizeUrl, tokenUrl,
 * registrationEndpoint as overrides), then RFC 7591 DCR against the registration endpoint
 * (unless the user supplied a `clientId` override, in which case we fall back to pre-registered
 * shape with no DCR). Returns a fully-populated `McpAuthOAuthConfig` ready to persist.
 */
async function runDcrAddFlow(
	params: Record<string, unknown>,
	transport: "http" | "stdio",
): Promise<McpAuthOAuthConfig> {
	if (transport === "stdio") {
		throw new RequestError(-32602, `${EXT_MCP_ADD}: stdio entries do not accept auth/headers/queries`);
	}
	const hasHeaders = params.headers !== undefined;
	const hasQueries = params.queries !== undefined;
	if (hasHeaders || hasQueries) {
		throw new RequestError(-32602, `${EXT_MCP_ADD}: auth "oauth-dcr" rejects sibling headers/queries`);
	}
	if (params.tokens !== undefined) {
		throw new RequestError(
			-32602,
			`${EXT_MCP_ADD}: tokens field is owned by the oauth handler; do not pass on /mcp add`,
		);
	}
	const url = requireNonEmptyString(params.url, "url");
	const overrideAuthorize = typeof params.authorizeUrl === "string" ? params.authorizeUrl : undefined;
	const overrideToken = typeof params.tokenUrl === "string" ? params.tokenUrl : undefined;
	const overrideRegistration =
		typeof params.registrationEndpoint === "string" ? params.registrationEndpoint : undefined;
	const overrideIssuer = typeof params.issuerUrl === "string" ? params.issuerUrl : undefined;
	const overrideClientId = typeof params.clientId === "string" ? params.clientId : undefined;
	const overrideClientSecret = typeof params.clientSecret === "string" ? params.clientSecret : undefined;
	const overrideRedirectUri = typeof params.redirectUri === "string" ? params.redirectUri : undefined;
	const overrideTokenAuthMethod = params.tokenAuthMethod;
	const overrideClientName = typeof params.clientName === "string" ? params.clientName : "bodhi-pi";

	// Discovery: skip when caller provided all the discovered fields explicitly OR when only DCR is
	// desired and registrationEndpoint is supplied.
	let authorizeUrl = overrideAuthorize;
	let tokenUrl = overrideToken;
	let registrationEndpoint = overrideRegistration;
	let issuerUrl = overrideIssuer;
	let scopesDiscovered: string[] | undefined;
	const needsDiscovery =
		authorizeUrl === undefined ||
		tokenUrl === undefined ||
		(registrationEndpoint === undefined && overrideClientId === undefined);
	if (needsDiscovery) {
		const info = await discoverOAuthServerInfo(overrideIssuer ?? url).catch((err) => {
			throw new RequestError(
				-32603,
				`${EXT_MCP_ADD}: oauth-dcr discovery failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
		issuerUrl = issuerUrl ?? info.authorizationServerUrl;
		const md = info.authorizationServerMetadata;
		if (!md) {
			throw new RequestError(
				-32603,
				`${EXT_MCP_ADD}: oauth-dcr discovery returned no metadata for ${overrideIssuer ?? url}`,
			);
		}
		authorizeUrl = authorizeUrl ?? md.authorization_endpoint;
		tokenUrl = tokenUrl ?? md.token_endpoint;
		registrationEndpoint = registrationEndpoint ?? md.registration_endpoint;
		scopesDiscovered = md.scopes_supported;
	}
	if (!authorizeUrl) throw new RequestError(-32603, `${EXT_MCP_ADD}: oauth-dcr could not resolve authorizeUrl`);
	if (!tokenUrl) throw new RequestError(-32603, `${EXT_MCP_ADD}: oauth-dcr could not resolve tokenUrl`);
	validateOauthUrl(authorizeUrl, "authorizeUrl");
	validateOauthUrl(tokenUrl, "tokenUrl");

	// Scope: user override > discovered server-supported scopes (default empty for "use default" semantics).
	let scopes: string[] | undefined;
	if (params.scopes !== undefined) {
		if (!Array.isArray(params.scopes) || !params.scopes.every((s) => typeof s === "string")) {
			throw new RequestError(-32602, `${EXT_MCP_ADD}: scopes must be a string[]`);
		}
		const userScopes = params.scopes as string[];
		if (userScopes.length > 0) scopes = userScopes;
	} else if (scopesDiscovered && scopesDiscovered.length > 0) {
		scopes = scopesDiscovered;
	}

	let clientId = overrideClientId;
	let clientSecret = overrideClientSecret;
	let tokenAuthMethodResolved: "basic" | "post" | undefined;
	if (overrideTokenAuthMethod !== undefined) {
		if (overrideTokenAuthMethod !== "basic" && overrideTokenAuthMethod !== "post") {
			throw new RequestError(-32602, `${EXT_MCP_ADD}: tokenAuthMethod must be "basic" or "post"`);
		}
		tokenAuthMethodResolved = overrideTokenAuthMethod;
	}
	let registrationAccessToken: string | undefined;
	let dcrRan = false;

	// DCR: only when the caller didn't supply a clientId override.
	if (!clientId) {
		if (!registrationEndpoint) {
			throw new RequestError(
				-32602,
				`${EXT_MCP_ADD}: oauth-dcr requires registrationEndpoint (none discovered or provided) — supply clientId+clientSecret to skip DCR`,
			);
		}
		if (!overrideRedirectUri) {
			throw new RequestError(
				-32602,
				`${EXT_MCP_ADD}: oauth-dcr requires redirectUri so the registered client can be used by the runtime`,
			);
		}
		const clientMetadata: OAuthClientMetadata = {
			redirect_uris: [overrideRedirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			client_name: overrideClientName,
			token_endpoint_auth_method: "client_secret_basic",
		};
		if (scopes && scopes.length > 0) clientMetadata.scope = scopes.join(" ");
		const registered = await registerClient(registrationEndpoint, {
			metadata: { registration_endpoint: registrationEndpoint } as Parameters<typeof registerClient>[1]["metadata"],
			clientMetadata,
			...(clientMetadata.scope !== undefined ? { scope: clientMetadata.scope } : {}),
		}).catch((err) => {
			throw new RequestError(
				-32603,
				`${EXT_MCP_ADD}: oauth-dcr registration failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
		clientId = registered.client_id;
		clientSecret = registered.client_secret;
		const ratField = (registered as { registration_access_token?: string }).registration_access_token;
		if (ratField) registrationAccessToken = ratField;
		dcrRan = true;
		if (
			!tokenAuthMethodResolved &&
			(registered.token_endpoint_auth_method === "client_secret_post" ||
				registered.token_endpoint_auth_method === "client_secret_basic")
		) {
			tokenAuthMethodResolved = registered.token_endpoint_auth_method === "client_secret_post" ? "post" : "basic";
		}
	}
	if (!clientId) {
		throw new RequestError(-32603, `${EXT_MCP_ADD}: oauth-dcr produced no clientId`);
	}

	const cfg: McpAuthOAuthConfig = {
		mode: "oauth",
		authorizeUrl,
		tokenUrl,
		clientId,
	};
	if (clientSecret) cfg.clientSecret = { name: "clientSecret", value: clientSecret, secret: true };
	if (scopes) cfg.scopes = scopes;
	if (overrideRedirectUri) cfg.redirectUri = overrideRedirectUri;
	if (tokenAuthMethodResolved) cfg.tokenAuthMethod = tokenAuthMethodResolved;
	if (dcrRan && registrationEndpoint) {
		const dcrInfo: McpDcrInfo = {
			issuerUrl: issuerUrl ?? authorizeUrl,
			registrationEndpoint,
			registeredAt: Date.now(),
		};
		if (registrationAccessToken) {
			dcrInfo.registrationAccessToken = {
				name: "registrationAccessToken",
				value: registrationAccessToken,
				secret: true,
			};
		}
		cfg.dcrInfo = dcrInfo;
	}
	return cfg;
}

function makeStateToken(tenantId: string | undefined): string {
	// 24 bytes → 32 base64url chars. Unguessable; doubles as the OAuthStateKv key.
	const arr = new Uint8Array(24);
	globalThis.crypto.getRandomValues(arr);
	const random = base64UrlEncodeBytes(arr);
	if (tenantId === undefined) return random;
	// Multi-tenant prefix: `<base64url(tenantId)>.<random>` so a process-wide /oauth/callback
	// route can split on the first `.` and decode the tenant without holding extra state.
	return `${base64UrlEncodeString(tenantId)}.${random}`;
}

/** Inverse of `makeStateToken`'s tenant prefix; returns `null` if the state has no tenant prefix. */
export function decodeTenantFromState(state: string): string | null {
	const idx = state.indexOf(".");
	if (idx <= 0) return null;
	try {
		return base64UrlDecodeToString(state.slice(0, idx));
	} catch {
		return null;
	}
}

/**
 * Cross-runtime base64url helpers — Web Crypto + `globalThis.atob`/`btoa` work in Node 19+ AND
 * every browser/worker we ship, with no `node:crypto` or `Buffer` coupling. Keeps bodhi-pi core
 * free of new Node-only imports per the deep-import discipline in CLAUDE.md.
 */
function base64UrlEncodeBytes(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return globalThis.btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(s: string): string {
	// utf8 → bytes via TextEncoder (global in Node 11+ and all browsers/workers).
	return base64UrlEncodeBytes(new TextEncoder().encode(s));
}

function base64UrlDecodeToString(s: string): string {
	// Reverse the base64url URL-safe alphabet then pad to a multiple of 4 for atob.
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
	const bin = globalThis.atob(padded);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder("utf-8").decode(bytes);
}

function parseStringArray(value: unknown, errPrefix: string): string[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
	throw new RequestError(-32602, `${errPrefix} must be a string[]`);
}

function parseNamedSecretListParam(value: unknown): McpNamedSecret[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) return [];
	const out: McpNamedSecret[] = [];
	for (const item of value) {
		if (item && typeof item === "object" && !Array.isArray(item)) {
			const o = item as { [k: string]: unknown };
			if (typeof o.name === "string" && typeof o.value === "string") {
				out.push({ name: o.name, value: o.value, secret: true });
			}
		}
	}
	return out;
}

/**
 * Parse the top-level `auth` discriminator and sibling `headers`/`queries` fields from the
 * `_bodhi-pi/mcp/add` params. Stdio entries (transport === "stdio") may omit `auth` entirely;
 * stdio auth is always treated as public. HTTP entries default to `"public"` when omitted.
 *
 * Validation:
 * - `auth` must be `"public"` or `"http-param"` if present
 * - `"public"` + sibling headers/queries present → -32602 (use `"http-param"` to attach)
 * - `"http-param"` + neither headers nor queries (or both empty) → -32602
 * - headers/queries must be `{ [name]: string }` objects; non-string values → -32602
 * - stdio + auth !== "public" (when present) → -32602
 */
/**
 * Synchronous parser for non-DCR auth inputs. DCR routes through `runDcrAddFlow` (async, hits the
 * network) before parseAuthInput so we keep the validation surface narrow + side-effect-free.
 */
function parseAuthInput(params: Record<string, unknown>, transport: "http" | "stdio"): McpAuthConfig {
	const rawAuth = params.auth;
	const headersIn = params.headers;
	const queriesIn = params.queries;
	const hasHeaders = headersIn !== undefined;
	const hasQueries = queriesIn !== undefined;
	const isKnownAuth =
		rawAuth === "public" || rawAuth === "http-param" || rawAuth === "oauth-preregistered" || rawAuth === "oauth-dcr";
	if (rawAuth !== undefined && !isKnownAuth) {
		throw new RequestError(
			-32602,
			`${EXT_MCP_ADD}: auth must be "public", "http-param", "oauth-preregistered", or "oauth-dcr"`,
		);
	}
	const authMode = isKnownAuth
		? (rawAuth as "public" | "http-param" | "oauth-preregistered" | "oauth-dcr")
		: undefined;
	if (transport === "stdio") {
		if (
			authMode === "http-param" ||
			authMode === "oauth-preregistered" ||
			authMode === "oauth-dcr" ||
			hasHeaders ||
			hasQueries
		) {
			throw new RequestError(-32602, `${EXT_MCP_ADD}: stdio entries do not accept auth/headers/queries`);
		}
		return { mode: "public" };
	}
	if (authMode === "oauth-dcr") {
		throw new RequestError(
			-32603,
			`${EXT_MCP_ADD}: internal — oauth-dcr must be routed through runDcrAddFlow before parseAuthInput`,
		);
	}
	// http transport
	const resolvedMode = authMode ?? "public";
	if (resolvedMode === "public") {
		if (hasHeaders || hasQueries) {
			throw new RequestError(
				-32602,
				`${EXT_MCP_ADD}: auth "public" rejects headers/queries; use auth "http-param" to attach`,
			);
		}
		return { mode: "public" };
	}
	if (resolvedMode === "oauth-preregistered") {
		if (hasHeaders || hasQueries) {
			throw new RequestError(-32602, `${EXT_MCP_ADD}: auth "oauth-preregistered" rejects sibling headers/queries`);
		}
		return parseOauthCredentialsInput(params);
	}
	// http-param
	const headers = hasHeaders ? parseStringRecord(headersIn, "headers") : undefined;
	const queries = hasQueries ? parseStringRecord(queriesIn, "queries") : undefined;
	const hasHeaderEntries = headers !== undefined && Object.keys(headers).length > 0;
	const hasQueryEntries = queries !== undefined && Object.keys(queries).length > 0;
	if (!hasHeaderEntries && !hasQueryEntries) {
		throw new RequestError(-32602, `${EXT_MCP_ADD}: auth "http-param" requires at least one header or query entry`);
	}
	const cfg: McpAuthHttpParamConfig = { mode: "http-param" };
	if (hasHeaderEntries) cfg.headers = recordToNamedSecrets(headers as Record<string, string>);
	if (hasQueryEntries) cfg.queries = recordToNamedSecrets(queries as Record<string, string>);
	return cfg;
}

/**
 * Build an `McpAuthOAuthConfig` from pre-registered credentials supplied on `/mcp add`. Used by
 * both `auth: "oauth-preregistered"` (direct) and `auth: "oauth-dcr"` (after the host has done
 * discovery + DCR and populated the credential fields).
 */
function parseOauthCredentialsInput(params: Record<string, unknown>): McpAuthOAuthConfig {
	const authorizeUrl = requireNonEmptyString(params.authorizeUrl, "authorizeUrl");
	const tokenUrl = requireNonEmptyString(params.tokenUrl, "tokenUrl");
	const clientId = requireNonEmptyString(params.clientId, "clientId");
	validateOauthUrl(authorizeUrl, "authorizeUrl");
	validateOauthUrl(tokenUrl, "tokenUrl");
	const cfg: McpAuthOAuthConfig = {
		mode: "oauth",
		authorizeUrl,
		tokenUrl,
		clientId,
	};
	if (params.clientSecret !== undefined) {
		if (typeof params.clientSecret !== "string" || params.clientSecret.length === 0) {
			throw new RequestError(-32602, `${EXT_MCP_ADD}: clientSecret must be a non-empty string`);
		}
		cfg.clientSecret = { name: "clientSecret", value: params.clientSecret, secret: true };
	}
	if (params.scopes !== undefined) {
		if (!Array.isArray(params.scopes) || !params.scopes.every((s) => typeof s === "string")) {
			throw new RequestError(-32602, `${EXT_MCP_ADD}: scopes must be a string[]`);
		}
		const scopes = params.scopes as string[];
		if (scopes.length > 0) cfg.scopes = scopes;
	}
	if (params.redirectUri !== undefined) {
		const redirectUri = requireNonEmptyString(params.redirectUri, "redirectUri");
		try {
			new URL(redirectUri);
		} catch {
			throw new RequestError(-32602, `${EXT_MCP_ADD}: redirectUri must be a valid URL`);
		}
		cfg.redirectUri = redirectUri;
	}
	if (params.tokenAuthMethod !== undefined) {
		if (params.tokenAuthMethod !== "basic" && params.tokenAuthMethod !== "post") {
			throw new RequestError(-32602, `${EXT_MCP_ADD}: tokenAuthMethod must be "basic" or "post"`);
		}
		cfg.tokenAuthMethod = params.tokenAuthMethod;
	}
	if (params.tokens !== undefined) {
		throw new RequestError(
			-32602,
			`${EXT_MCP_ADD}: tokens field is owned by the oauth handler; do not pass on /mcp add`,
		);
	}
	return cfg;
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new RequestError(-32602, `${EXT_MCP_ADD}: ${field} must be a non-empty string`);
	}
	return value;
}

function validateOauthUrl(value: string, field: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new RequestError(-32602, `${EXT_MCP_ADD}: ${field} must be a valid URL`);
	}
	const isHttps = url.protocol === "https:";
	const isLocalHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
	if (!isHttps && !isLocalHttp) {
		throw new RequestError(-32602, `${EXT_MCP_ADD}: ${field} must use https (http allowed only for localhost)`);
	}
}

function parseStringRecord(value: unknown, field: string): Record<string, string> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new RequestError(-32602, `${EXT_MCP_ADD}: ${field} must be a { name: value } object`);
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof v !== "string") {
			throw new RequestError(-32602, `${EXT_MCP_ADD}: ${field}["${k}"] must be a string`);
		}
		out[k] = v;
	}
	return out;
}

function recordToNamedSecrets(record: Record<string, string>): McpNamedSecret[] {
	return Object.entries(record).map(([name, value]) => ({ name, value, secret: true }));
}
