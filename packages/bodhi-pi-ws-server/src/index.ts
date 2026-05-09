import path from "node:path";
import { config as loadEnv } from "dotenv";
import { resolveModelsFromEnv } from "./models.js";
import { buildServer } from "./server.js";

loadEnv();

const port = Number(process.env.PORT ?? 8788);
const dataDir = process.env.BODHI_PI_SERVER_DATA_DIR ?? path.resolve(".bodhi-pi-server");

const { models, defaultModelId, getApiKey } = resolveModelsFromEnv();

const server = await buildServer({ port, dataDir, models, defaultModelId, getApiKey });
const actualPort = server.port();
console.log(`bodhi-pi-ws-server listening on http://localhost:${actualPort}`);
console.log(`  health:    http://localhost:${actualPort}/healthz`);
console.log(`  agent ws:  ws://localhost:${actualPort}/agent`);
console.log(`  data dir:  ${dataDir}`);
console.log(`  models:    ${models.map((m) => m.id).join(", ")}`);

const shutdown = async (signal: string) => {
	console.log(`\nreceived ${signal}, shutting down`);
	await server.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
