/**
 * Resolved env for a browser host.
 *
 * After Phase J: zero API-key reading from build-time env vars (those bake into
 * shipped static JS and leak). All auth lives in the host-injected `KvStore`
 * (Dexie/IndexedDB), populated via `/login <provider> <api-key>` at runtime.
 * The agent core builds the model list dynamically from pi-ai's catalog
 * filtered by stored auth.
 */
export interface ResolvedEnv {}

export function buildResolvedEnv(_getEnvVar: (key: string) => string | undefined): ResolvedEnv {
	return {};
}
