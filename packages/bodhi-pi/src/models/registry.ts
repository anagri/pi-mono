import { randomUUID } from "node:crypto";
import {
	RequestError,
	type SessionConfigOption,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import {
	type Api,
	clampThinkingLevel,
	getModels,
	getProviders,
	getSupportedThinkingLevels,
	type KnownProvider,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { EventDispatcher } from "@/events/dispatcher.js";
import type { ExtensionRunner } from "@/extensions/runner.js";
import { extractAuthApiKey, extractAuthBaseUrl } from "@/kv/auth-format.js";
import { AUTH_PREFIX, type JsonValue, type KvStore } from "@/kv/kv-store.js";
import type { SessionEntry } from "@/sessions/entries.js";
import type { ResolvedRetryOptions, SessionState } from "@/sessions/session-state.js";
import {
	type BodhiPiProjectSettings,
	type ProviderOptionsEntry,
	resolveSettingsDefaultModelId,
} from "@/settings/settings.js";
import { MODEL_CONFIG_ID, THINKING_CONFIG_ID } from "@/wire/constants.js";

export type AppendEntry = (sessionId: string, session: SessionState, entry: SessionEntry) => Promise<void>;

export interface ModelRegistryDeps {
	/** Host-supplied additive models (e.g., local Ollama). */
	hostModels?: Model<Api>[];
	/** Host-explicit default model id. */
	defaultModelId?: string;
	/** Host-supplied API-key fallback consulted after the KV store. */
	getApiKey?: (provider: string) => string | undefined;
	kvStore?: KvStore;
	sessions: Map<string, SessionState>;
	events: EventDispatcher;
	appendEntry: AppendEntry;
	extensionRunner: () => ExtensionRunner | undefined;
}

/**
 * `pi-agent-core` types `state.thinkingLevel` as a narrow `ThinkingLevel` union; pi-ai's
 * `ModelThinkingLevel` is wider. The two shapes are runtime-identical (string enum) but the
 * compiler needs a bridge. Centralize the cast in one helper so future fixes upstream can flip
 * a single line.
 */
export function assignThinkingLevel(piAgentState: { thinkingLevel: unknown }, level: ModelThinkingLevel): void {
	(piAgentState as { thinkingLevel: ModelThinkingLevel }).thinkingLevel = level;
}

/** Pure transform — exported so the bootstrap can call it without going through the registry. */
export function resolveProviderStreamOptions(provider: string, merged: BodhiPiProjectSettings): ResolvedRetryOptions {
	const perProvider: ProviderOptionsEntry | undefined = merged.providerOptions?.[provider];
	const defaults = merged.retry;
	const out: ResolvedRetryOptions = {};
	const maxRetries = perProvider?.maxRetries ?? defaults?.maxRetries;
	const timeoutMs = perProvider?.timeoutMs;
	const maxRetryDelayMs = perProvider?.maxRetryDelayMs ?? defaults?.maxDelayMs;
	if (maxRetries !== undefined) out.maxRetries = maxRetries;
	if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
	if (maxRetryDelayMs !== undefined) out.maxRetryDelayMs = maxRetryDelayMs;
	return out;
}

export class ModelRegistry {
	private readonly hostModels: Model<Api>[];
	private readonly defaultModelId: string | undefined;
	private readonly getApiKey: ((provider: string) => string | undefined) | undefined;
	private readonly kvStore: KvStore | undefined;
	private readonly sessions: Map<string, SessionState>;
	private readonly events: EventDispatcher;
	private readonly appendEntry: AppendEntry;
	private readonly extensionRunner: () => ExtensionRunner | undefined;

	constructor(deps: ModelRegistryDeps) {
		this.hostModels = deps.hostModels ?? [];
		this.defaultModelId = deps.defaultModelId;
		this.getApiKey = deps.getApiKey;
		this.kvStore = deps.kvStore;
		this.sessions = deps.sessions;
		this.events = deps.events;
		this.appendEntry = deps.appendEntry;
		this.extensionRunner = deps.extensionRunner;
	}

	async resolveProviderAuth(provider: string): Promise<JsonValue | undefined> {
		return await this.kvStore?.get(AUTH_PREFIX + provider);
	}

	async resolveProviderApiKey(provider: string): Promise<string | undefined> {
		// Order: kvStore (set by /login) > host getApiKey > extension fallback.
		// Keyless case: kvStore has auth/<provider> with base_url but no api_key → return "mock"
		// sentinel so pi-ai's unconditional Bearer header is non-empty (aimock / Ollama / llama.cpp ignore it).
		const auth = await this.resolveProviderAuth(provider);
		if (auth !== undefined) {
			const apiKey = extractAuthApiKey(auth);
			if (apiKey !== undefined) return apiKey;
			if (extractAuthBaseUrl(auth) !== undefined) return "mock";
		}
		const hostKey = this.getApiKey?.(provider);
		if (hostKey !== undefined) return hostKey;
		const ext = await this.extensionRunner()?.resolveProviderKey(provider);
		return ext ?? undefined;
	}

	async resolveProviderBaseUrl(provider: string): Promise<string | undefined> {
		const auth = await this.resolveProviderAuth(provider);
		return auth === undefined ? undefined : extractAuthBaseUrl(auth);
	}

	async allModels(): Promise<Model<Api>[]> {
		const out: Model<Api>[] = [];
		const seen = new Set<string>();
		const hostProviders = new Set<string>();
		const push = (m: Model<Api>) => {
			if (seen.has(m.id)) return;
			seen.add(m.id);
			out.push(m);
		};
		// Host-supplied models win — if the host listed ANY model for a provider, pi-ai's catalog
		// is suppressed for that provider. A KV-stored base_url (set via /login) still overrides
		// the host's default when present.
		for (const m of this.hostModels) {
			const baseUrl = await this.resolveProviderBaseUrl(m.provider);
			push(baseUrl ? { ...m, baseUrl } : m);
			hostProviders.add(m.provider);
		}
		for (const m of this.extensionRunner()?.getProviderModels() ?? []) {
			const baseUrl = await this.resolveProviderBaseUrl(m.provider);
			push(baseUrl ? { ...m, baseUrl } : m);
			hostProviders.add(m.provider);
		}
		for (const provider of getProviders()) {
			if (hostProviders.has(provider)) continue;
			const key = await this.resolveProviderApiKey(provider);
			if (!key) continue;
			const baseUrl = await this.resolveProviderBaseUrl(provider);
			for (const m of getModels(provider as KnownProvider) as Model<Api>[]) {
				push(baseUrl ? { ...m, baseUrl } : m);
			}
		}
		return out;
	}

	async findModel(id: string): Promise<Model<Api>> {
		const models = await this.allModels();
		const m = models.find((x) => x.id === id);
		if (!m) {
			throw new RequestError(
				-32602,
				`unknown or unavailable model id: "${id}" — run /login <provider> api_key="..." first`,
			);
		}
		return m;
	}

	/** Precedence: host `defaultModelId` → `mergedFileSettings.defaultModelId` (or legacy `defaultModel`) → first auth-available; `null` when none. */
	async pickDefaultModelIdOrNull(merged: BodhiPiProjectSettings): Promise<string | null> {
		const models = await this.allModels();
		if (this.defaultModelId && models.find((m) => m.id === this.defaultModelId)) return this.defaultModelId;
		const fromSettings = resolveSettingsDefaultModelId(merged);
		if (fromSettings && models.find((m) => m.id === fromSettings)) return fromSettings;
		return models[0]?.id ?? null;
	}

	/** Falls back to first available so a stale per-session default still boots with *some* working model. */
	async resolveSessionModel(requestedId: string | null): Promise<Model<Api> | null> {
		const models = await this.allModels();
		if (requestedId) {
			const hit = models.find((m) => m.id === requestedId);
			if (hit) return hit;
		}
		return models[0] ?? null;
	}

	private async buildModelConfigOption(currentValue: string | null): Promise<SessionConfigOption> {
		const models = await this.allModels();
		return {
			id: MODEL_CONFIG_ID,
			name: "Model",
			category: "model",
			type: "select",
			currentValue: currentValue ?? "",
			options: models.map((m) => ({ value: m.id, name: m.name })),
		};
	}

	private buildThinkingConfigOption(session: SessionState): SessionConfigOption | undefined {
		const model = session.runtime.piAgent.state.model;
		const supported = getSupportedThinkingLevels(model);
		if (supported.length <= 1) return undefined;
		return {
			id: THINKING_CONFIG_ID,
			name: "Thinking",
			category: "model",
			type: "select",
			currentValue: session.runtime.thinkingLevel,
			options: supported.map((level) => ({ value: level, name: level })),
		};
	}

	async buildAllConfigOptions(sessionId: string): Promise<SessionConfigOption[]> {
		const session = this.sessions.get(sessionId);
		if (!session) return [];
		const options: SessionConfigOption[] = [await this.buildModelConfigOption(session.runtime.currentModelId)];
		const thinking = this.buildThinkingConfigOption(session);
		if (thinking) options.push(thinking);
		return options;
	}

	/** Dispatch table for `setSessionConfigOption`. Add a new entry to support a new config option. */
	private readonly configOptionSetters: Record<
		string,
		(sessionId: string, session: SessionState, value: unknown) => Promise<void>
	> = {
		[MODEL_CONFIG_ID]: (sid, s, v) => this.setSessionModel(sid, s, v),
		[THINKING_CONFIG_ID]: (sid, s, v) => this.setSessionThinkingLevel(sid, s, v),
	};

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			throw new RequestError(-32602, `unknown session: ${params.sessionId}`);
		}
		const setter = this.configOptionSetters[params.configId];
		if (!setter) {
			throw new RequestError(-32602, `unknown configId: ${params.configId}`);
		}
		await setter(params.sessionId, session, params.value);
		return { configOptions: await this.buildAllConfigOptions(params.sessionId) };
	}

	private async setSessionModel(sessionId: string, session: SessionState, value: unknown): Promise<void> {
		if (typeof value !== "string") {
			throw new RequestError(-32602, `model config requires string value, got ${typeof value}`);
		}
		const newModel = await this.findModel(value);
		const previousModelId = session.runtime.currentModelId;
		session.runtime.piAgent.state.model = newModel;
		session.runtime.currentModelId = value;
		const clamped = clampThinkingLevel(newModel, session.runtime.thinkingLevel);
		if (clamped !== session.runtime.thinkingLevel) {
			session.runtime.thinkingLevel = clamped;
			assignThinkingLevel(session.runtime.piAgent.state, clamped);
			session.runtime.pendingThinkingLevelChange = true;
		}
		await this.appendEntry(sessionId, session, {
			type: "model_change",
			id: randomUUID(),
			parentId: session.runtime.leafId,
			timestamp: Date.now(),
			provider: newModel.provider,
			modelId: newModel.id,
		});
		await this.events.emit({
			type: "model_select",
			sessionId,
			fromModelId: previousModelId,
			toModelId: value,
		});
	}

	private async setSessionThinkingLevel(sessionId: string, session: SessionState, value: unknown): Promise<void> {
		if (typeof value !== "string") {
			throw new RequestError(-32602, `thinking config requires string value, got ${typeof value}`);
		}
		const supported = getSupportedThinkingLevels(session.runtime.piAgent.state.model);
		if (!supported.includes(value as ModelThinkingLevel)) {
			throw new RequestError(
				-32602,
				`unsupported thinking level "${value}" for model ${session.runtime.piAgent.state.model.id}; supported: ${supported.join(", ")}`,
			);
		}
		const level = value as ModelThinkingLevel;
		if (level === session.runtime.thinkingLevel) return;
		session.runtime.thinkingLevel = level;
		assignThinkingLevel(session.runtime.piAgent.state, level);
		session.runtime.pendingThinkingLevelChange = true;
		await this.appendEntry(sessionId, session, {
			type: "thinking_change",
			id: randomUUID(),
			parentId: session.runtime.leafId,
			timestamp: Date.now(),
			level,
		});
	}
}
