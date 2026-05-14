import { AUTH_PREFIX, type JsonValue } from "./kv-store.js";

export { AUTH_PREFIX };

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

/** Extract `auth.api_key.value` from the persisted `auth/<provider>` JsonValue; `undefined` on any shape mismatch. */
export function extractAuthApiKey(auth: JsonValue): string | undefined {
	if (auth === null || typeof auth !== "object" || Array.isArray(auth)) return undefined;
	const apiKey = (auth as { [k: string]: JsonValue }).api_key;
	if (apiKey === null || typeof apiKey !== "object" || Array.isArray(apiKey)) return undefined;
	const value = (apiKey as { [k: string]: JsonValue }).value;
	return typeof value === "string" ? value : undefined;
}

/** Extract `auth.base_url` from the persisted `auth/<provider>` JsonValue; `undefined` on any shape mismatch. */
export function extractAuthBaseUrl(auth: JsonValue): string | undefined {
	if (auth === null || typeof auth !== "object" || Array.isArray(auth)) return undefined;
	const baseUrl = (auth as { [k: string]: JsonValue }).base_url;
	return typeof baseUrl === "string" ? baseUrl : undefined;
}

/** Build the `auth/<provider>` JsonValue from a client-side `ProviderAuth`. The `api_key.secret: true` marker triggers masking on KV read. */
export function normalizeProviderAuth(config: ProviderAuth): JsonValue {
	const out: { [k: string]: JsonValue } = {};
	if (config.api_key !== undefined) {
		out.api_key = { value: config.api_key.value, secret: true };
	}
	if (config.base_url !== undefined) {
		out.base_url = config.base_url;
	}
	return out;
}

/** Parse a persisted `auth/<provider>` JsonValue back into a typed `ProviderAuth`; `null` on shape mismatch. */
export function parseProviderAuth(value: JsonValue | null): ProviderAuth | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const obj = value as { [k: string]: JsonValue };
	const config: ProviderAuth = {};
	const apiKey = obj.api_key;
	if (apiKey !== undefined && apiKey !== null && typeof apiKey === "object" && !Array.isArray(apiKey)) {
		const inner = apiKey as { [k: string]: JsonValue };
		if (typeof inner.value === "string") {
			config.api_key = { value: inner.value, secret: true };
		}
	}
	if (typeof obj.base_url === "string") config.base_url = obj.base_url;
	return config;
}
