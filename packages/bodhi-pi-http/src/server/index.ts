import path from "node:path";
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

const server = await buildServer({
	port,
	dataDir,
	...(cli.workspace !== undefined ? { workspaceOverride: cli.workspace } : {}),
});
const actualPort = server.port();
console.log(`bodhi-pi-http listening on http://localhost:${actualPort}`);
console.log(`  health:    http://localhost:${actualPort}/healthz`);
console.log(`  acp:       http://localhost:${actualPort}/acp`);
console.log(`  data dir:  ${dataDir}`);
console.log(`  workspace: ${cli.workspace ?? `<per-user under ${dataDir}/users/<id>/workspace/>`}`);
console.log(`  models:    auto-derived from stored auth (use /login <provider> api_key="..." from a client)`);

const shutdown = async (signal: string) => {
	console.log(`\nreceived ${signal}, shutting down`);
	await server.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
