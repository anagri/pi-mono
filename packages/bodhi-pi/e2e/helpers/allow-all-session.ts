import type { NewSessionRequest, NewSessionResponse } from "@agentclientprotocol/sdk";
import { type BodhiPiAcpConnection, MODE_CONFIG_ID } from "@/index.js";

/**
 * `newSession` + switch the session to `allow-all` so tool-behavior e2e tests (bash, fs, commands,
 * run_script, mcp, extensions) run their tool calls without an ask-mode approval prompt. Ask mode is
 * the enforcing default since milestone 040; these suites assert TOOL behavior, not the approval flow
 * (which is covered by `ask-mode.e2e.ts` + `ask-mode.spec.ts`). Mirrors the A2 integration triage.
 */
export async function newAllowAllSession(
	conn: BodhiPiAcpConnection,
	params: NewSessionRequest,
): Promise<NewSessionResponse> {
	const res = await conn.newSession(params);
	await conn.setSessionConfigOption({ sessionId: res.sessionId, configId: MODE_CONFIG_ID, value: "allow-all" });
	return res;
}
