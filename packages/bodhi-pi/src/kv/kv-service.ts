import { RequestError } from "@agentclientprotocol/sdk";
import type { EventDispatcher } from "@/events/dispatcher.js";
import { EXT_KV_GET, EXT_KV_LIST, EXT_KV_REMOVE, EXT_KV_SET } from "@/wire/constants.js";
import { optionalSessionId, requireStringParam } from "@/wire/validators.js";
import { AUTH_PREFIX, type JsonValue, type KvStore, maskSecrets } from "./kv-store.js";

type ExtHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface KvServiceDeps {
	kvStore?: KvStore;
	events: EventDispatcher;
}

export class KvService {
	private readonly kvStore: KvStore | undefined;
	private readonly events: EventDispatcher;

	constructor(deps: KvServiceDeps) {
		this.kvStore = deps.kvStore;
		this.events = deps.events;
	}

	register(): Array<[string, ExtHandler]> {
		return [
			[EXT_KV_SET, this.handleKvSet.bind(this)],
			[EXT_KV_GET, this.handleKvGet.bind(this)],
			[EXT_KV_LIST, this.handleKvList.bind(this)],
			[EXT_KV_REMOVE, this.handleKvRemove.bind(this)],
		];
	}

	private requireKvStore(method: string): KvStore {
		if (!this.kvStore) {
			throw new RequestError(-32601, `${method}: kvStore not configured on this host`);
		}
		return this.kvStore;
	}

	private async handleKvSet(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKvStore(EXT_KV_SET);
		const key = requireStringParam(EXT_KV_SET, params, "key");
		if (!("value" in params)) {
			throw new RequestError(-32602, `${EXT_KV_SET}: value is required`);
		}
		const value = params.value as JsonValue;
		await kv.set(key, value);
		if (key.startsWith(AUTH_PREFIX)) {
			await this.events.emit({
				type: "auth_change",
				sessionId: optionalSessionId(params),
				provider: key.slice(AUTH_PREFIX.length),
				action: "login",
			});
		}
		return { key };
	}

	private async handleKvGet(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKvStore(EXT_KV_GET);
		const key = requireStringParam(EXT_KV_GET, params, "key");
		const value = await kv.get(key);
		if (value === undefined) return { key, value: null };
		return { key, value: maskSecrets(value) };
	}

	private async handleKvList(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKvStore(EXT_KV_LIST);
		const prefix = params.prefix;
		if (prefix !== undefined && typeof prefix !== "string") {
			throw new RequestError(-32602, `${EXT_KV_LIST}: prefix must be a string`);
		}
		const entries = await kv.list(prefix);
		return {
			entries: entries.map((e) => ({ key: e.key, value: maskSecrets(e.value) })),
		};
	}

	private async handleKvRemove(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKvStore(EXT_KV_REMOVE);
		const key = requireStringParam(EXT_KV_REMOVE, params, "key");
		await kv.remove(key);
		if (key.startsWith(AUTH_PREFIX)) {
			await this.events.emit({
				type: "auth_change",
				sessionId: optionalSessionId(params),
				provider: key.slice(AUTH_PREFIX.length),
				action: "logout",
			});
		}
		return { key };
	}
}
