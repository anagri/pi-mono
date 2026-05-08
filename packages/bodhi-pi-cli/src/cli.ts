#!/usr/bin/env node
import { createBodhiPiAgent } from "@bodhiapp/bodhi-pi";
import { config as loadEnv } from "dotenv";
import { resolveConfig } from "./config.js";
import { createNodeFilesystem } from "./fs/node-filesystem.js";
import { runRepl } from "./repl/repl.js";
import { createSqliteSessionStore } from "./sessions/sqlite-session-store.js";

loadEnv();

const cfg = resolveConfig(process.argv.slice(2));
const cwd = process.cwd();
const filesystem = createNodeFilesystem(cwd);
const sessionStore = createSqliteSessionStore(cfg.dbPath);

const factory = createBodhiPiAgent({
	models: cfg.models,
	defaultModelId: cfg.defaultModelId,
	getApiKey: cfg.getApiKey,
	sessionStore,
	filesystem,
	...(cfg.systemPrompt !== undefined ? { systemPrompt: cfg.systemPrompt } : {}),
});

await runRepl({ factory, cwd, sessionStore, models: cfg.models });
