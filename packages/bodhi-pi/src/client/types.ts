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

export interface ProviderApiKey {
	value: string;
	secret?: true;
}

export interface ProviderAuth {
	api_key?: ProviderApiKey;
	base_url?: string;
}

export interface ProviderAuthEntry {
	provider: string;
	config: ProviderAuth;
}

export type AddProviderOptions = SessionRef;

export type RemoveProviderOptions = SessionRef;

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
