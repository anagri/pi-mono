import {
	type Agent,
	AgentSideConnection,
	type AnyMessage,
	type Client,
	ClientSideConnection,
	type Stream,
} from "@agentclientprotocol/sdk";

export function createInProcessAcpPair(
	toAgent: (conn: AgentSideConnection) => Agent,
	toClient: (agent: Agent) => Client,
): { agentConn: AgentSideConnection; clientConn: ClientSideConnection } {
	const a2c = new TransformStream<AnyMessage, AnyMessage>();
	const c2a = new TransformStream<AnyMessage, AnyMessage>();

	const agentStream: Stream = { readable: c2a.readable, writable: a2c.writable };
	const clientStream: Stream = { readable: a2c.readable, writable: c2a.writable };

	const agentConn = new AgentSideConnection(toAgent, agentStream);
	const clientConn = new ClientSideConnection(toClient, clientStream);
	return { agentConn, clientConn };
}
