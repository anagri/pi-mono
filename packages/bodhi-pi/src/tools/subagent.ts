import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { SubagentService } from "@/subagents/subagent-service.js";
import type { SubagentProfile } from "@/subagents/types.js";

export interface SubagentToolDeps {
	sessionId: string;
	profiles: SubagentProfile[];
	service: SubagentService;
}

export function createSubagentTool(deps: SubagentToolDeps): AgentTool<ReturnType<typeof buildSubagentSchema>> {
	const profileLines = deps.profiles.map((p) => `- ${p.name} (context: ${p.context}): ${p.description}`).join("\n");
	const parameters = buildSubagentSchema(deps.profiles);
	const profilesByName = new Map(deps.profiles.map((p) => [p.name, p]));

	return {
		name: "subagent",
		label: "subagent",
		description: `Delegate a focused task to a specialized sub-agent profile. The sub-agent runs independently with a constrained toolset and returns its findings as text.

Available profiles:
${profileLines}

Use this when:
- The task is self-contained and can be delegated to a specialist
- You want to isolate a focused investigation from the main conversation

**Parallel dispatch (IMPORTANT)**: when you have N independent sub-agent tasks (e.g. word-count + line-count + char-count on the same file, or "review correctness", "review tests", "review docs" of the same PR), emit ALL N \`subagent\` tool calls **in a single assistant message** — do NOT emit one, wait for it, then emit the next. The runtime executes simultaneously-emitted tool calls concurrently via Promise.all; emitting them sequentially across turns serialises them and multiplies wall-clock time. There is no "subagent_batch" tool — parallelism comes from you emitting multiple subagent tool calls together.

Context behavior is decided by the profile, not by this call:
- context: fresh — the sub-agent starts with NO parent history; include all relevant context in the task description.
- context: fork — the sub-agent inherits a filtered slice of the parent's transcript (prior user turns, assistant turns, tool calls + results); the task can refer to that context without repeating it.`,
		parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			const profile = profilesByName.get(params.agent);
			if (!profile) {
				throw new Error(`unknown sub-agent profile: ${params.agent}`);
			}
			const result = await deps.service.spawn({
				parentSessionId: deps.sessionId,
				profile,
				task: params.task,
				toolCallId,
				...(params.model !== undefined ? { modelOverride: params.model } : {}),
				...(signal !== undefined ? { signal } : {}),
				...(onUpdate !== undefined ? { onUpdate } : {}),
			});
			return deps.service.buildToolResult(result, profile);
		},
	};
}

function buildSubagentSchema(profiles: SubagentProfile[]) {
	const names = profiles.map((p) => p.name);
	return Type.Object(
		{
			agent: Type.Union(
				names.map((n) => Type.Literal(n)),
				{ description: "Sub-agent profile name. Must be one of the available profiles." },
			),
			task: Type.String({
				description: "Self-contained task description. The sub-agent does NOT see the parent conversation.",
			}),
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
