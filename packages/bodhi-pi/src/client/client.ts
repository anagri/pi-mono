import type {
	CloseSessionRequest,
	InitializeRequest,
	ListSessionsRequest,
	LoadSessionRequest,
	NewSessionRequest,
	PromptRequest,
	ResumeSessionRequest,
	SetSessionConfigOptionRequest,
	SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import { pickDefined } from "@/_internal/object.js";
import { normalizeProviderAuth, parseProviderAuth } from "@/kv/auth-format.js";
import { AUTH_PREFIX } from "@/kv/kv-store.js";
import {
	EXT_DELETE_SESSION,
	EXT_KV_GET,
	EXT_KV_LIST,
	EXT_KV_REMOVE,
	EXT_KV_SET,
	EXT_SESSION_CLONE,
	EXT_SESSION_COMPACT,
	EXT_SESSION_CONFIG,
	EXT_SESSION_ENTRIES,
	EXT_SESSION_EXPORT,
	EXT_SESSION_FORK,
	EXT_SESSION_NAVIGATE,
	EXT_SESSION_SET_NAME,
	EXT_SESSION_SETTINGS_GET,
	EXT_SESSION_SETTINGS_LIST,
	EXT_SESSION_SETTINGS_SET,
	EXT_SESSION_SETTINGS_UNSET,
	EXT_SESSION_STATS,
	EXT_SESSION_TREE,
	MODEL_CONFIG_ID,
} from "@/wire/constants.js";
import { modelConfigFromOptions } from "./config-options.js";
import type {
	AddProviderOptions,
	BodhiPiAcpConnection,
	BodhiPiClientOptions,
	CloneSessionResult,
	CompactSessionParams,
	CompactSessionResult,
	ExportSessionResult,
	ForkSessionParams,
	ForkSessionResult,
	KvGetParams,
	KvGetResult,
	KvListParams,
	KvListResult,
	KvRemoveParams,
	KvRemoveResult,
	KvSetParams,
	KvSetResult,
	ModelConfigState,
	NavigateSessionParams,
	NavigateSessionResult,
	ProviderAuth,
	ProviderAuthEntry,
	RemoveProviderOptions,
	SessionConfigResult,
	SessionEntriesResult,
	SessionRef,
	SessionStatsResult,
	SessionTreeResult,
	SetSessionNameParams,
	SetSessionNameResult,
	SettingsGetParams,
	SettingsGetResult,
	SettingsListParams,
	SettingsListResult,
	SettingsSetParams,
	SettingsSetResult,
	SettingsUnsetParams,
	SettingsUnsetResult,
} from "./types.js";

const INIT_PARAMS: InitializeRequest = {
	protocolVersion: 1,
	clientCapabilities: {
		fs: { readTextFile: false, writeTextFile: false },
		terminal: false,
	},
};

function providerKey(provider: string): string {
	return `${AUTH_PREFIX}${provider}`;
}

function providerFromKey(key: string): string {
	return key.startsWith(AUTH_PREFIX) ? key.slice(AUTH_PREFIX.length) : key;
}

function requireString(value: string | undefined, message: string): string {
	if (!value) throw new Error(message);
	return value;
}

export class BodhiPiClient {
	readonly acp: BodhiPiAcpConnection;
	private defaultCwd: string;
	private activeSessionId: string | undefined;
	private lastConfigOptions: SetSessionConfigOptionResponse["configOptions"] | undefined;

	constructor(acp: BodhiPiAcpConnection, opts: BodhiPiClientOptions = {}) {
		this.acp = acp;
		this.defaultCwd = opts.cwd ?? "/";
		this.settings = {
			list: (params: SettingsListParams = {}) => this.listSettings(params),
			get: (params: SettingsGetParams) => this.getSetting(params),
			set: (params: SettingsSetParams) => this.setSetting(params),
			unset: (params: SettingsUnsetParams) => this.unsetSetting(params),
		};
		this.kv = {
			set: (params) => this.kvSet(params),
			get: (params) => this.kvGet(params),
			list: (params = {}) => this.kvList(params),
			remove: (params) => this.kvRemove(params),
		};
	}

	readonly settings: {
		list(params?: SettingsListParams): Promise<SettingsListResult>;
		get(params: SettingsGetParams): Promise<SettingsGetResult>;
		set(params: SettingsSetParams): Promise<SettingsSetResult>;
		unset(params: SettingsUnsetParams): Promise<SettingsUnsetResult>;
	};

	readonly kv: {
		set(params: KvSetParams): Promise<KvSetResult>;
		get(params: KvGetParams): Promise<KvGetResult>;
		list(params?: KvListParams): Promise<KvListResult>;
		remove(params: KvRemoveParams): Promise<KvRemoveResult>;
	};

	get sessionId(): string | undefined {
		return this.activeSessionId;
	}

	get cwd(): string {
		return this.defaultCwd;
	}

	set cwd(value: string) {
		this.defaultCwd = value;
	}

	initialize(params: Partial<InitializeRequest> = {}) {
		return this.acp.initialize({ ...INIT_PARAMS, ...params });
	}

	async newSession(params: Partial<NewSessionRequest> = {}) {
		const result = await this.acp.newSession({
			cwd: params.cwd ?? this.defaultCwd,
			mcpServers: params.mcpServers ?? [],
			...pickDefined({ additionalDirectories: params.additionalDirectories }),
			...pickDefined({ _meta: params._meta }),
		});
		this.activeSessionId = result.sessionId;
		this.lastConfigOptions = result.configOptions ?? undefined;
		return result;
	}

	async loadSession(params: { sessionId: string } & Partial<Omit<LoadSessionRequest, "sessionId">>) {
		const result = await this.acp.loadSession({
			sessionId: params.sessionId,
			cwd: params.cwd ?? this.defaultCwd,
			mcpServers: params.mcpServers ?? [],
			...pickDefined({ additionalDirectories: params.additionalDirectories }),
			...pickDefined({ _meta: params._meta }),
		});
		this.activeSessionId = params.sessionId;
		this.lastConfigOptions = result.configOptions ?? undefined;
		return result;
	}

	async resumeSession(params: { sessionId: string } & Partial<Omit<ResumeSessionRequest, "sessionId">>) {
		const result = await this.acp.resumeSession({
			sessionId: params.sessionId,
			cwd: params.cwd ?? this.defaultCwd,
			mcpServers: params.mcpServers ?? [],
			...pickDefined({ additionalDirectories: params.additionalDirectories }),
			...pickDefined({ _meta: params._meta }),
		});
		this.activeSessionId = params.sessionId;
		this.lastConfigOptions = result.configOptions ?? undefined;
		return result;
	}

	listSessions(params: ListSessionsRequest = {}) {
		return this.acp.listSessions(params);
	}

	async closeSession(params: Partial<CloseSessionRequest> = {}) {
		const sessionId = this.requireSession(params);
		const result = await this.acp.closeSession({
			sessionId,
			...pickDefined({ _meta: params._meta }),
		});
		if (this.activeSessionId === sessionId) this.activeSessionId = undefined;
		return result;
	}

	cancel(params: SessionRef = {}) {
		return this.acp.cancel({ sessionId: this.requireSession(params) });
	}

	prompt(
		text: string,
		params?: SessionRef,
	): Promise<ReturnType<BodhiPiAcpConnection["prompt"]> extends Promise<infer T> ? T : never>;
	prompt(params: PromptRequest): ReturnType<BodhiPiAcpConnection["prompt"]>;
	prompt(textOrParams: string | PromptRequest, params: SessionRef = {}) {
		if (typeof textOrParams !== "string") return this.acp.prompt(textOrParams);
		return this.acp.prompt({
			sessionId: this.requireSession(params),
			prompt: [{ type: "text", text: textOrParams }],
		});
	}

	async setConfigOption(params: Omit<SetSessionConfigOptionRequest, "sessionId"> & SessionRef) {
		const result = await this.acp.setSessionConfigOption({
			...params,
			sessionId: this.requireSession(params),
		} as SetSessionConfigOptionRequest);
		this.lastConfigOptions = result.configOptions;
		return result;
	}

	async model(modelId?: string, params: SessionRef = {}): Promise<string> {
		if (modelId === undefined) {
			const cached = this.models().currentModelId;
			if (cached) return cached;
			const config = await this.getSessionConfig(params);
			return config.currentModelId ?? "";
		}
		const result = await this.setConfigOption({
			sessionId: params.sessionId,
			configId: MODEL_CONFIG_ID,
			value: modelId,
		});
		return modelConfigFromOptions(result.configOptions).currentModelId;
	}

	models(): ModelConfigState {
		return modelConfigFromOptions(this.lastConfigOptions);
	}

	ext<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		return this.acp.extMethod(method, params) as Promise<T>;
	}

	async addProvider(provider: string, config: ProviderAuth, opts: AddProviderOptions = {}): Promise<KvSetResult> {
		return this.ext<KvSetResult>(EXT_KV_SET, {
			...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : this.optionalActiveSession()),
			key: providerKey(provider),
			value: normalizeProviderAuth(config),
		});
	}

	async removeProvider(provider: string, opts: RemoveProviderOptions = {}): Promise<KvRemoveResult> {
		return this.ext<KvRemoveResult>(EXT_KV_REMOVE, {
			...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : this.optionalActiveSession()),
			key: providerKey(provider),
		});
	}

	async getProvider(provider: string): Promise<ProviderAuthEntry | null> {
		const result = await this.ext<KvGetResult>(EXT_KV_GET, { key: providerKey(provider) });
		const config = parseProviderAuth(result.value);
		return config ? { provider, config } : null;
	}

	async listProviders(): Promise<ProviderAuthEntry[]> {
		const result = await this.ext<KvListResult>(EXT_KV_LIST, { prefix: AUTH_PREFIX });
		const out: ProviderAuthEntry[] = [];
		for (const entry of result.entries) {
			const config = parseProviderAuth(entry.value);
			if (config) out.push({ provider: providerFromKey(entry.key), config });
		}
		return out;
	}

	deleteSession(params: { sessionId: string }) {
		return this.ext(EXT_DELETE_SESSION, { sessionId: params.sessionId });
	}

	compactSession(params: CompactSessionParams = {}): Promise<CompactSessionResult> {
		const sessionId = this.requireSession(params);
		return this.ext<CompactSessionResult>(EXT_SESSION_COMPACT, {
			sessionId,
			...pickDefined({ customInstructions: params.customInstructions }),
		});
	}

	forkSession(params: ForkSessionParams): Promise<ForkSessionResult> {
		return this.ext<ForkSessionResult>(EXT_SESSION_FORK, {
			sessionId: this.requireSession(params),
			entryId: params.entryId,
			...pickDefined({ position: params.position }),
		});
	}

	cloneSession(params: SessionRef = {}): Promise<CloneSessionResult> {
		return this.ext<CloneSessionResult>(EXT_SESSION_CLONE, { sessionId: this.requireSession(params) });
	}

	listSessionEntries(params: SessionRef = {}): Promise<SessionEntriesResult> {
		return this.ext<SessionEntriesResult>(EXT_SESSION_ENTRIES, { sessionId: this.requireSession(params) });
	}

	getSessionTree(params: SessionRef = {}): Promise<SessionTreeResult> {
		return this.ext<SessionTreeResult>(EXT_SESSION_TREE, { sessionId: this.requireSession(params) });
	}

	navigateSession(params: NavigateSessionParams): Promise<NavigateSessionResult> {
		return this.ext<NavigateSessionResult>(EXT_SESSION_NAVIGATE, {
			sessionId: this.requireSession(params),
			targetEntryId: params.targetEntryId,
		});
	}

	setSessionName(params: SetSessionNameParams): Promise<SetSessionNameResult> {
		return this.ext<SetSessionNameResult>(EXT_SESSION_SET_NAME, {
			sessionId: this.requireSession(params),
			name: params.name,
		});
	}

	getSessionStats(params: SessionRef = {}): Promise<SessionStatsResult> {
		return this.ext<SessionStatsResult>(EXT_SESSION_STATS, { sessionId: this.requireSession(params) });
	}

	exportSession(params: SessionRef = {}): Promise<ExportSessionResult> {
		return this.ext<ExportSessionResult>(EXT_SESSION_EXPORT, { sessionId: this.requireSession(params) });
	}

	getSessionConfig(params: SessionRef = {}): Promise<SessionConfigResult> {
		return this.ext<SessionConfigResult>(EXT_SESSION_CONFIG, { sessionId: this.requireSession(params) });
	}

	private kvSet(params: KvSetParams): Promise<KvSetResult> {
		return this.ext<KvSetResult>(EXT_KV_SET, {
			key: params.key,
			value: params.value,
			...pickDefined({ sessionId: params.sessionId }),
		});
	}

	private kvGet(params: KvGetParams): Promise<KvGetResult> {
		return this.ext<KvGetResult>(EXT_KV_GET, { key: params.key });
	}

	private kvList(params: KvListParams): Promise<KvListResult> {
		return this.ext<KvListResult>(EXT_KV_LIST, {
			...pickDefined({ prefix: params.prefix }),
		});
	}

	private kvRemove(params: KvRemoveParams): Promise<KvRemoveResult> {
		return this.ext<KvRemoveResult>(EXT_KV_REMOVE, {
			key: params.key,
			...pickDefined({ sessionId: params.sessionId }),
		});
	}

	private listSettings(params: SettingsListParams): Promise<SettingsListResult> {
		return this.ext<SettingsListResult>(EXT_SESSION_SETTINGS_LIST, {
			sessionId: this.requireSession(params),
			...pickDefined({ scope: params.scope }),
		});
	}

	private getSetting(params: SettingsGetParams): Promise<SettingsGetResult> {
		return this.ext<SettingsGetResult>(EXT_SESSION_SETTINGS_GET, {
			sessionId: this.requireSession(params),
			key: params.key,
			...pickDefined({ scope: params.scope }),
		});
	}

	private setSetting(params: SettingsSetParams): Promise<SettingsSetResult> {
		return this.ext<SettingsSetResult>(EXT_SESSION_SETTINGS_SET, {
			sessionId: this.requireSession(params),
			key: params.key,
			value: params.value,
			...pickDefined({ scope: params.scope }),
		});
	}

	private unsetSetting(params: SettingsUnsetParams): Promise<SettingsUnsetResult> {
		return this.ext<SettingsUnsetResult>(EXT_SESSION_SETTINGS_UNSET, {
			sessionId: this.requireSession(params),
			key: params.key,
			...pickDefined({ scope: params.scope }),
		});
	}

	private requireSession(params: SessionRef): string {
		return requireString(params.sessionId ?? this.activeSessionId, "BodhiPiClient requires an active session");
	}

	private optionalActiveSession(): { sessionId: string } | Record<string, never> {
		return this.activeSessionId ? { sessionId: this.activeSessionId } : {};
	}
}

export function createBodhiPiClient(acp: BodhiPiAcpConnection, opts: BodhiPiClientOptions = {}): BodhiPiClient {
	return new BodhiPiClient(acp, opts);
}
