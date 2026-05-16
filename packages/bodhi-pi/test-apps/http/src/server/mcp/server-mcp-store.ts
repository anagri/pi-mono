import { createInProcessMcpConnectionProvider, type McpConnectionProvider } from "@bodhiapp/bodhi-pi";

/**
 * Per-user `McpConnectionProvider` cache, server-process-scoped.
 *
 * `bodhi-pi-test-app-http` rebuilds its `BodhiPiAcpAgent` per request — if the
 * MCP connection map lived on the agent, every request would lose all
 * connections. The server keeps one `McpConnectionProvider` instance per
 * authenticated user, hands it to `wireAgentForRequest`, and the agent's
 * `McpService` consults it for connection lifecycle and tool reads.
 *
 * No eviction: test-app server lifetime is short and per-user memory is
 * bounded by test runs. Production hosts would add LRU / idle-timeout policy.
 */
export class ServerMcpStore {
	private readonly byUser = new Map<string, McpConnectionProvider>();

	getProviderForUser(userId: string): McpConnectionProvider {
		let p = this.byUser.get(userId);
		if (!p) {
			p = createInProcessMcpConnectionProvider();
			this.byUser.set(userId, p);
		}
		return p;
	}
}
