import { Agent, type AgentOptions } from "@mariozechner/pi-agent-core";

/**
 * Construct a bodhi-pi agent session.
 *
 * For M1.1 this is a thin factory over pi-agent-core's Agent. Future milestones
 * extend this with session persistence, resource loading, host bindings, and
 * the rest of the embedding surface.
 */
export function createAgentSession(options: AgentOptions): Agent {
	return new Agent(options);
}
