import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { BodhiPiLogger } from "@/acp/agent.js";
import type { EventDispatcher } from "@/events/dispatcher.js";
import type { BodhiPiEventHandlers } from "@/events/types.js";
import type { SessionStore } from "@/sessions/session-store.js";
import { ExtensionRunner, type RequestSlashableRefresh } from "./runner.js";
import type { RegisteredExtension } from "./types.js";

export interface ExtensionRunnerHostDeps {
	conn: AgentSideConnection;
	sessionStore: SessionStore;
	events: EventDispatcher;
	logger: BodhiPiLogger;
	factories: RegisteredExtension[] | undefined;
	requestSlashableRefresh: RequestSlashableRefresh;
}

/**
 * Owns the lazy `ExtensionRunner` build for the agent. The first `ensure()` call builds the
 * runner (idempotent across concurrent callers) and appends extension-contributed event
 * handlers onto the shared `EventDispatcher`. Required-extension failures propagate; optional
 * failures are captured and surfaced via {@link getExtensionErrorNames}.
 *
 * Extracted from `BodhiPiAcpAgent` as part of D2 to shrink the god-class. The runner itself
 * still lives in `src/extensions/runner.ts`; this host is the agent-side scaffolding.
 */
export class ExtensionRunnerHost {
	private readonly deps: ExtensionRunnerHostDeps;
	private runner?: ExtensionRunner;
	private ready?: Promise<void>;

	constructor(deps: ExtensionRunnerHostDeps) {
		this.deps = deps;
	}

	async ensure(): Promise<ExtensionRunner | undefined> {
		const { factories } = this.deps;
		if (!factories || factories.length === 0) return undefined;
		if (this.runner) return this.runner;
		if (!this.ready) {
			this.ready = (async () => {
				const runner = await ExtensionRunner.build({
					conn: this.deps.conn,
					sessionStore: this.deps.sessionStore,
					extensions: factories,
					requestSlashableRefresh: this.deps.requestSlashableRefresh,
					logger: this.deps.logger,
				});
				this.runner = runner;
				const extHandlers = runner.getEventHandlers();
				for (const [type, list] of Object.entries(extHandlers) as [
					keyof BodhiPiEventHandlers,
					NonNullable<BodhiPiEventHandlers[keyof BodhiPiEventHandlers]>,
				][]) {
					if (!list || list.length === 0) continue;
					this.deps.events.appendHandlers(type, list);
				}
			})();
		}
		await this.ready;
		return this.runner;
	}

	current(): ExtensionRunner | undefined {
		return this.runner;
	}

	getExtensionErrorNames(): string[] {
		return this.runner?.getExtensionErrors().map((e) => e.extensionName) ?? [];
	}
}
