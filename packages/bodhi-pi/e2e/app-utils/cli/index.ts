// Node-side adapters + session stores shared across the Node test-apps
// (test-app-cli, test-app-http). Single barrel so consumers import via
// `@e2e/app-utils/cli`.

export { defaultDbPath } from "./default-db-path.js";
export { createNodeKvStore, type NodeKvStoreOptions } from "./kv-store.js";
export { createNodeScriptExecutor } from "./script-executor.js";
export {
	createSqliteSessionStore as createMultiTenantSqliteSessionStore,
	type Db,
	type MultiTenantSessionStoreOptions,
	type OpenDbOptions,
	openDb,
	upsertUser,
} from "./sessions/multi-tenant/store.js";
export {
	createSqliteSessionStore as createSingleTenantSqliteSessionStore,
	type SqliteSessionStoreOptions as SingleTenantSqliteSessionStoreOptions,
} from "./sessions/single-tenant/store.js";
