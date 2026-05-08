#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { createCliAgent } from "./agent.js";
import { resolveConfig } from "./config.js";
import { runRepl } from "./repl/repl.js";

loadEnv();

const cfg = resolveConfig(process.argv.slice(2));
const agent = createCliAgent({
	cwd: process.cwd(),
	dbPath: cfg.dbPath,
	models: cfg.models,
	defaultModelId: cfg.defaultModelId,
	getApiKey: cfg.getApiKey,
	...(cfg.systemPrompt !== undefined ? { systemPrompt: cfg.systemPrompt } : {}),
});

await runRepl({ factory: agent.factory, cwd: agent.cwd, sessionStore: agent.sessionStore, models: agent.models });
