import type {
	ClientSideConnection,
	InitializeRequest,
	InitializeResponse,
	ListSessionsRequest,
	ListSessionsResponse,
	LoadSessionRequest,
	LoadSessionResponse,
	NewSessionRequest,
	NewSessionResponse,
	PromptRequest,
	PromptResponse,
	ResumeSessionRequest,
	ResumeSessionResponse,
	SessionConfigOption,
	SetSessionConfigOptionRequest,
	SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type { JsonValue } from "@/kv/kv-store.js";

export interface BodhiPiAcpConnection {
	initialize(params: InitializeRequest): Promise<InitializeResponse>;
	newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
	loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
	resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;
	listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse>;
	closeSession: ClientSideConnection["closeSession"];
	setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>;
	prompt(params: PromptRequest): Promise<PromptResponse>;
	cancel(params: { sessionId: string }): Promise<void>;
	extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface BodhiPiClientOptions {
	cwd?: string;
}

export interface SessionRef {
	sessionId?: string;
}

export interface ModelOption {
	id: string;
	name: string;
	description?: string | null;
}

export interface ModelConfigState {
	currentModelId: string;
	models: ModelOption[];
	option?: SessionConfigOption;
}

export interface KvSetParams {
	key: string;
	value: JsonValue;
	/** Scopes an emitted `auth_change` event to this session when the key is under `auth/*`. */
	sessionId?: string;
}

export interface KvGetParams {
	key: string;
}

export interface KvListParams {
	prefix?: string;
}

export interface KvRemoveParams {
	key: string;
	/** Scopes an emitted `auth_change` event to this session when the key is under `auth/*`. */
	sessionId?: string;
}

export interface KvSetResult {
	key: string;
}

export interface KvGetResult {
	key: string;
	value: JsonValue | null;
}

export interface KvListResult {
	entries: Array<{ key: string; value: JsonValue }>;
}

export interface KvRemoveResult {
	key: string;
}

export type { ProviderApiKey, ProviderAuth, ProviderAuthEntry } from "@/kv/auth-format.js";

export type AddProviderOptions = SessionRef;

export type RemoveProviderOptions = SessionRef;

// --- MCP --------------------------------------------------------------

export type McpTransport = "http" | "stdio";
/** Auth mode discriminator. Extends with `"oauth-dcr"`, `"oauth-preregistered"` as those land. */
export type McpAuthMode = "public" | "http-param";
export type McpStatus = "connected" | "disconnected" | "error";

export interface McpNamedValueInput {
	name: string;
	value: string;
}

/**
 * HTTP MCP add params, discriminated on the top-level `auth` field. Mirrors the wire shape
 * accepted by `_bodhi-pi/mcp/add`. `"http-param"` carries sibling `headers` and/or `queries`
 * objects whose values become per-request secret attachments.
 */
export type McpAddHttpParams =
	| {
			url: string;
			auth: "public";
			label?: string;
	  }
	| {
			url: string;
			auth: "http-param";
			headers?: Record<string, string>;
			queries?: Record<string, string>;
			label?: string;
	  };

export interface McpAddStdioParams {
	command: string;
	args?: string[];
	env?: McpNamedValueInput[];
	label?: string;
}

export type McpAddParams = McpAddHttpParams | McpAddStdioParams;

export interface McpAddResult {
	slug: string;
}

export interface McpConnectParams {
	slug: string;
}

export interface McpConnectResult {
	tools: string[];
}

export interface McpDisconnectResult {
	slug: string;
}

export interface McpRemoveResult {
	slug: string;
}

export interface McpIncludeParams extends SessionRef {
	slug: string;
}

export interface McpIncludeResult {
	slug: string;
	tools: string[];
}

export interface McpExcludeParams extends SessionRef {
	slug: string;
}

export interface McpExcludeResult {
	slug: string;
}

/**
 * `_bodhi-pi/mcp/list` response item. The `auth` field carries the persisted auth blob with
 * secret values masked to `"***"` (per `maskSecrets`); shape mirrors `_bodhi-pi/mcp/add` input
 * but with `headers`/`queries` flattened into `McpNamedSecret[]` form for uniform masking.
 */
export interface McpListItem {
	slug: string;
	label: string;
	transport: McpTransport;
	status: McpStatus;
	url?: string;
	command?: string;
	auth: JsonValue;
}

export interface McpToolsResult {
	tools: string[];
}

export interface CompactSessionParams extends SessionRef {
	customInstructions?: string;
}

export interface CompactSessionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: unknown;
}

export interface ForkSessionParams extends SessionRef {
	entryId: string;
	position?: "before" | "at";
}

export interface ForkSessionResult {
	newSessionId: string;
	selectedText?: string;
}

export type CloneSessionResult = {
	newSessionId: string;
};

export interface SessionEntriesResult {
	entries: Array<{ id: string; role: string; preview: string }>;
}

export interface SessionTreeResult {
	leafId: string | null;
	nodes: Array<{
		id: string;
		parentId: string | null;
		type: string;
		role?: string;
		preview?: string;
		isLeaf: boolean;
	}>;
}

export interface NavigateSessionParams extends SessionRef {
	targetEntryId: string;
}

export interface NavigateSessionResult {
	leafId: string;
}

export interface SetSessionNameParams extends SessionRef {
	name: string;
}

export interface SetSessionNameResult {
	ok: boolean;
	name: string;
}

export interface SessionStatsResult {
	messageCount: number;
	toolCallCount: number;
	leafId: string | null;
	name?: string;
}

export interface ExportSessionResult {
	format: string;
	content: string;
}

export interface SessionConfigResult {
	sessionId: string;
	cwd: string;
	defaultModelId: string | null;
	currentModelId: string | null;
	thinkingLevel?: string;
	retryOptions?: Record<string, unknown>;
	compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	appendSystemPrompt: string | null;
	contextFilePaths: string[];
	globalSettingsParseError?: string;
	projectSettingsParseError?: string;
}

export type SettingsScope = "global" | "project" | "session";
export type SettingsListScope = SettingsScope | "effective";

export interface SettingsListParams extends SessionRef {
	scope?: SettingsListScope;
}

export interface SettingsListResult {
	scope: SettingsListScope;
	settings: Record<string, unknown>;
}

export interface SettingsGetParams extends SessionRef {
	key: string;
	scope?: SettingsScope;
}

export interface SettingsGetResult {
	key: string;
	scope: SettingsScope | "effective";
	value: unknown;
	effective: unknown;
	source: SettingsScope | "default";
}

export interface SettingsSetParams extends SessionRef {
	key: string;
	value: unknown;
	scope?: SettingsScope;
}

export interface SettingsSetResult {
	key: string;
	scope: SettingsScope;
	effective: unknown;
}

export interface SettingsUnsetParams extends SessionRef {
	key: string;
	scope?: SettingsScope;
}

export type SettingsUnsetResult = SettingsSetResult;
