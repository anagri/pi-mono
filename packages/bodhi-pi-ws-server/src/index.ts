import { config as loadEnv } from "dotenv";
import { buildServer } from "./server.js";

loadEnv();

const port = Number(process.env.PORT ?? 8788);

const server = await buildServer({ port });
const actualPort = server.port();
console.log(`bodhi-pi-ws-server listening on http://localhost:${actualPort}`);
console.log(`  health:    http://localhost:${actualPort}/healthz`);
console.log(`  agent ws:  ws://localhost:${actualPort}/agent`);

const shutdown = async (signal: string) => {
	console.log(`\nreceived ${signal}, shutting down`);
	await server.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
