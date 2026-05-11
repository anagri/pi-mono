#!/usr/bin/env node
import os from "node:os";
import { createNodeExtensionLoader } from "@bodhiapp/bodhi-pi-node";
import { createCliAgent } from "./agent.js";
import { resolveConfig } from "./config.js";
import { runRepl } from "./repl/repl.js";

const cfg = resolveConfig(process.argv.slice(2));
const cwd = cfg.cwd;

const extensionFactories = cfg.loadExtensions ? await createNodeExtensionLoader({ cwd }) : [];

const agent = createCliAgent({
	cwd,
	dbPath: cfg.dbPath,
	homeDir: os.homedir(),
	...(cfg.systemPrompt !== undefined ? { systemPrompt: cfg.systemPrompt } : {}),
	...(cfg.appendSystemPrompt !== undefined ? { appendSystemPrompt: cfg.appendSystemPrompt } : {}),
	...(cfg.eventHandlers ? { eventHandlers: cfg.eventHandlers } : {}),
	...(extensionFactories.length > 0 ? { extensionFactories } : {}),
});

if (cfg.loadExtensions && extensionFactories.length > 0) {
	process.stderr.write(`[bodhi-pi-cli] loaded ${extensionFactories.length} extension(s) from .bodhi-pi/extensions/\n`);
}

await runRepl({ factory: agent.factory, cwd: agent.cwd, sessionStore: agent.sessionStore });
