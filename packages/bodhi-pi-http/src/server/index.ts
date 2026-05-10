import path from "node:path";
import { config as loadEnv } from "dotenv";
import { parseArgs } from "./cli-args.js";
import { resolveModelsFromEnv } from "./models.js";
import { buildServer } from "./server.js";

loadEnv();

let cli: ReturnType<typeof parseArgs>;
try {
	cli = parseArgs(process.argv.slice(2));
} catch (err) {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
}

const port = cli.port ?? Number(process.env.PORT ?? 3000);
const dataDir = cli.dataDir ?? process.env.BODHI_PI_HTTP_DATA_DIR ?? path.resolve(".bodhi-pi-http");

const { models, defaultModelId, getApiKey } = resolveModelsFromEnv();

const server = await buildServer({
	port,
	dataDir,
	models,
	defaultModelId,
	getApiKey,
	...(cli.workspace !== undefined ? { workspaceOverride: cli.workspace } : {}),
});
const actualPort = server.port();
console.log(`bodhi-pi-http listening on http://localhost:${actualPort}`);
console.log(`  health:    http://localhost:${actualPort}/healthz`);
console.log(`  acp:       http://localhost:${actualPort}/acp`);
console.log(`  data dir:  ${dataDir}`);
console.log(`  workspace: ${cli.workspace ?? `<per-user under ${dataDir}/users/<id>/workspace/>`}`);
console.log(`  models:    ${models.map((m) => m.id).join(", ")}`);

const shutdown = async (signal: string) => {
	console.log(`\nreceived ${signal}, shutting down`);
	await server.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
