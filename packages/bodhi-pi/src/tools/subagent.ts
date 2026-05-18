import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { SubagentProfile } from "@/subagents/types.js";

export interface SubagentToolDeps {
	sessionId: string;
	profiles: SubagentProfile[];
}

export function createSubagentTool(deps: SubagentToolDeps): AgentTool<ReturnType<typeof buildSubagentSchema>> {
	const profileLines = deps.profiles.map((p) => `- ${p.name}: ${p.description}`).join("\n");
	const parameters = buildSubagentSchema(deps.profiles);

	return {
		name: "subagent",
		label: "subagent",
		description: `Delegate a focused task to a specialized sub-agent profile. The sub-agent runs independently with a constrained toolset and returns its findings as text.

Available profiles:
${profileLines}

Use this when:
- The task is self-contained and can be delegated to a specialist
- You want to isolate a focused investigation from the main conversation

Default context is fresh — the sub-agent does NOT see the parent conversation, so include all relevant context in the task description.`,
		parameters,
		async execute(_toolCallId: string, _params: Static<typeof parameters>) {
			throw new Error("subagent tool: spawn path lands in C2");
		},
	};
}

function buildSubagentSchema(profiles: SubagentProfile[]) {
	const names = profiles.map((p) => p.name);
	return Type.Object(
		{
			agent: Type.Union(
				names.map((n) => Type.Literal(n)),
				{
					description: "Sub-agent profile name. Must be one of the available profiles.",
				},
			),
			task: Type.String({
				description: "Self-contained task description. The sub-agent does NOT see the parent conversation.",
			}),
			context: Type.Optional(
				Type.Literal("fresh", {
					description: "Context mode. Only 'fresh' is supported in v1.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Override the model id for this run. Defaults to the profile's model if set, else the parent's current model.",
				}),
			),
		},
		{ additionalProperties: false },
	);
}
