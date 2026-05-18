import { RequestError } from "@agentclientprotocol/sdk";
import { requireLiveSession } from "@/sessions/resolution.js";
import type { SessionState } from "@/sessions/session-state.js";
import type { SessionStore } from "@/sessions/session-store.js";
import { EXT_SUBAGENT_CHILDREN, EXT_SUBAGENT_LIST, EXT_SUBAGENT_RUN } from "@/wire/constants.js";
import { profileToSummary } from "./types.js";

type ExtHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface SubagentServiceDeps {
	sessions: Map<string, SessionState>;
	sessionStore: SessionStore;
}

export class SubagentService {
	private readonly sessions: Map<string, SessionState>;
	private readonly sessionStore: SessionStore;

	constructor(deps: SubagentServiceDeps) {
		this.sessions = deps.sessions;
		this.sessionStore = deps.sessionStore;
	}

	register(): Array<[string, ExtHandler]> {
		return [
			[EXT_SUBAGENT_LIST, this.handleList.bind(this)],
			[EXT_SUBAGENT_RUN, this.handleRun.bind(this)],
			[EXT_SUBAGENT_CHILDREN, this.handleChildren.bind(this)],
		];
	}

	private async handleList(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { session } = requireLiveSession(this.sessions, EXT_SUBAGENT_LIST, params);
		return {
			profiles: session.subagentProfiles.map(profileToSummary),
		};
	}

	private async handleRun(_params: Record<string, unknown>): Promise<Record<string, unknown>> {
		throw new RequestError(-32601, `${EXT_SUBAGENT_RUN}: not implemented yet (lands in C2)`);
	}

	private async handleChildren(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { sessionId } = requireLiveSession(this.sessions, EXT_SUBAGENT_CHILDREN, params);
		const result = await this.sessionStore.list({
			parentSessionId: sessionId,
			includeSubagentChildren: true,
		});
		return { children: result.sessions };
	}
}
