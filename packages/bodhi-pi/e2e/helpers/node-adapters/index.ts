// helpers/node-adapters/ keeps only the Filesystem adapter — that's the one
// adapter the e2e harness itself imports (in cli/http/ws createCliHarness etc.
// to expose a read-only proxy over the real cwd). Test-app-only Node adapters
// (kv-store, script-executor, sessions, default-db-path, key-encoding) live
// under app-utils/cli/.

export { createNodeFilesystem, type NodeFilesystemOptions } from "./filesystem.js";
