import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type { createBodhiPiAgent, SessionStore } from "@bodhiapp/bodhi-pi";

export interface RpcModeOptions {
	factory: ReturnType<typeof createBodhiPiAgent>;
	cwd: string;
	sessionStore: SessionStore;
}

export async function runRpcMode(opts: RpcModeOptions): Promise<void> {
	const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
	const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
	const stream = ndJsonStream(output, input);
	const conn = new AgentSideConnection(opts.factory, stream);
	void conn;
	await new Promise<void>((resolve) => process.stdin.once("end", resolve));
}
