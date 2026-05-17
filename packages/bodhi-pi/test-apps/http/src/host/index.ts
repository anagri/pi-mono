import path from "node:path";
import { type Api, getModel, type Model } from "@earendil-works/pi-ai";
import { parseArgs } from "./cli-args.js";
import { buildServer } from "./server.js";

let cli: ReturnType<typeof parseArgs>;
try {
	cli = parseArgs(process.argv.slice(2));
} catch (err) {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
}

const port = cli.port ?? Number(process.env.PORT ?? 3000);
const dataDir = cli.dataDir ?? path.resolve(".bodhi-pi-http");

const models: Model<Api>[] = [];
if (cli.models) {
	for (const pair of cli.models.split(",")) {
		const [provider, modelId] = pair.split(":");
		if (!provider || !modelId) {
			process.stderr.write(`[test-app-http] invalid --models entry: ${pair}\n`);
			process.exit(1);
		}
		const m = (getModel as unknown as (p: string, id: string) => Model<Api> | undefined)(provider, modelId);
		if (!m) {
			process.stderr.write(`[test-app-http] unknown model: ${pair}\n`);
			process.exit(1);
		}
		models.push(m);
	}
}

// Test-app convenience: env-based getApiKey fallback so the spawned server
// has model access without an explicit /login. Production bodhi-pi-http
// resolves keys exclusively via KvStore.
const PROVIDER_ENV: Record<string, string> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	google: "GOOGLE_API_KEY",
	groq: "GROQ_API_KEY",
	xai: "XAI_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
};

const envGetApiKey = (provider: string): string | undefined => {
	const envName = PROVIDER_ENV[provider];
	return envName ? process.env[envName] : undefined;
};

const server = await buildServer({
	port,
	dataDir,
	getApiKey: envGetApiKey,
	...(models.length > 0 ? { models } : {}),
	...(cli.defaultModel !== undefined ? { defaultModelId: cli.defaultModel } : {}),
	...(cli.workspace !== undefined ? { workspaceOverride: cli.workspace } : {}),
});
const actualPort = server.port();
console.log(`bodhi-pi-test-app-http listening on http://localhost:${actualPort}`);
console.log(`  health:    http://localhost:${actualPort}/healthz`);
console.log(`  acp:       http://localhost:${actualPort}/acp`);
console.log(`  acp-ws:    ws://localhost:${actualPort}/acp-ws`);
console.log(`  data dir:  ${dataDir}`);
console.log(`  workspace: ${cli.workspace ?? `<per-user under ${dataDir}/users/<id>/workspace/>`}`);
console.log(
	`  models:    ${models.length > 0 ? models.map((m) => `${m.provider}:${m.id}`).join(", ") : "<env-driven>"}`,
);

const shutdown = async (signal: string) => {
	console.log(`\nreceived ${signal}, shutting down`);
	await server.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
