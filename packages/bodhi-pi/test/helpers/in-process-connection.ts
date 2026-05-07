import {
	type Agent,
	AgentSideConnection,
	type AnyMessage,
	type Client,
	ClientSideConnection,
	type Stream,
} from "@agentclientprotocol/sdk";

/**
 * Creates an in-memory ACP connection pair: AgentSideConnection ↔ ClientSideConnection,
 * wired via two TransformStreams. Each test owns its own pair — no shared state, no
 * stdio, safe for vitest concurrency.
 */
export function createInProcessAcpPair(
	toAgent: (conn: AgentSideConnection) => Agent,
	toClient: (agent: Agent) => Client,
): { agentConn: AgentSideConnection; clientConn: ClientSideConnection } {
	const a2c = new TransformStream<AnyMessage, AnyMessage>(); // agent → client
	const c2a = new TransformStream<AnyMessage, AnyMessage>(); // client → agent

	const agentStream: Stream = { readable: c2a.readable, writable: a2c.writable };
	const clientStream: Stream = { readable: a2c.readable, writable: c2a.writable };

	const agentConn = new AgentSideConnection(toAgent, agentStream);
	const clientConn = new ClientSideConnection(toClient, clientStream);
	return { agentConn, clientConn };
}
