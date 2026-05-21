import { recorder } from "@test/helpers/event-recorder.js";
import { createTestHarness } from "@test/helpers/harness.js";
import { createTestScriptExecutor } from "@test/helpers/script-executor.js";
import { Bash } from "just-bash";
import {
	createBodhiPiClient,
	createInMemoryFilesystem,
	createInMemoryKvStore,
	createInMemorySessionStore,
} from "@/index.js";
import { waitForAgentEndBalance } from "../events-assert.js";
import type { E2EHarness, E2EHarnessOptions } from "../harness.js";
import { createJustBashTerminal } from "../node-adapters/just-bash-terminal.js";
import { pickDefined } from "../pick-defined.js";
import { loadFixtureFactoriesFromSource } from "../seed-bodhi-pi.js";
import { createReadOnlyFilesystemProxy, seedFilesViaFilesystem } from "../test-filesystem.js";

export async function createInMemoryHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
	const filesystem = opts.filesystem ?? createInMemoryFilesystem();
	const sessionStore = opts.sessionStore ?? createInMemorySessionStore();
	const kvStore = opts.kvStore ?? createInMemoryKvStore();
	// Default scriptExecutor reads from the harness's filesystem so run_script
	// tests work without explicit wiring. The cli/http runtimes use the real
	// Node executor via their respective hosts.
	const scriptExecutor = opts.scriptExecutor ?? createTestScriptExecutor(filesystem);
	const cwd = opts.homeDir ?? "/proj";
	const terminal = createJustBashTerminal(Bash, { filesystem, defaultCwd: cwd });
	const { log: events, handlers } = recorder();
	const extensionFactories = opts.bodhiPiFixture ? await loadFixtureFactoriesFromSource(opts.bodhiPiFixture) : [];
	const inner = createTestHarness({
		models: opts.models,
		defaultModelId: opts.defaultModelId,
		filesystem,
		sessionStore,
		kvStore,
		scriptExecutor,
		terminal,
		eventHandlers: handlers,
		...pickDefined({
			getApiKey: opts.getApiKey,
			systemPrompt: opts.systemPrompt,
			appendSystemPrompt: opts.appendSystemPrompt,
			compaction: opts.compaction,
			homeDir: opts.homeDir,
		}),
		// extensionFactories is omitted when empty so createTestHarness uses its
		// own default. (pickDefined would forward an empty array.)
		...(extensionFactories.length > 0 ? { extensionFactories } : {}),
	});
	await filesystem.mkdir(cwd, { recursive: true });
	return {
		clientConn: inner.clientConn,
		client: createBodhiPiClient(inner.clientConn, { cwd }),
		updates: inner.updates,
		events,
		flushEvents: () => waitForAgentEndBalance(events),
		filesystem: createReadOnlyFilesystemProxy(inner.filesystem),
		setupFiles: (files) => seedFilesViaFilesystem(inner.filesystem, cwd, files),
		sessionStore: inner.sessionStore,
		kvStore: inner.kvStore,
		cwd,
		cleanup: async () => {},
	};
}
