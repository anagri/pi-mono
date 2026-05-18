import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { SubagentService, SubagentSpawnBatchInput } from "@/subagents/subagent-service.js";
import type { SubagentProfile } from "@/subagents/types.js";

export interface SubagentBatchToolDeps {
	sessionId: string;
	profiles: SubagentProfile[];
	service: SubagentService;
}

export function createSubagentBatchTool(
	deps: SubagentBatchToolDeps,
): AgentTool<ReturnType<typeof buildSubagentBatchSchema>> {
	const profileLines = deps.profiles.map((p) => `- ${p.name} (context: ${p.context}): ${p.description}`).join("\n");
	const parameters = buildSubagentBatchSchema(deps.profiles);
	const profilesByName = new Map(deps.profiles.map((p) => [p.name, p]));
	const cap = deps.service.batchConcurrencyCap;

	return {
		name: "subagent_batch",
		label: "subagent_batch",
		description: `Dispatch 2-${cap} sub-agents concurrently from a single tool call. Each child runs in parallel; results are returned in the same order as the input \`tasks\`.

Available profiles:
${profileLines}

Use this when:
- You have several independent investigations that don't need to wait for each other (e.g. "review correctness, tests, and cleanup in parallel").
- Each task is self-contained — children do NOT see each other's output.

\`failFast: true\` aborts in-flight siblings on the first child that does not complete successfully; the default (collect-all) lets every child run to completion and surfaces per-child status. Use a single \`subagent\` tool call for one task — \`subagent_batch\` requires at least 2.`,
		parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			const inputs: SubagentSpawnBatchInput["tasks"] = params.tasks.map((t) => {
				const profile = profilesByName.get(t.agent);
				if (!profile) throw new Error(`unknown sub-agent profile: ${t.agent}`);
				return {
					profile,
					task: t.task,
					...(t.model !== undefined ? { modelOverride: t.model } : {}),
				};
			});
			const batch = await deps.service.spawnBatch({
				parentSessionId: deps.sessionId,
				batchToolCallId: toolCallId,
				tasks: inputs,
				...(params.failFast === true ? { failFast: true } : {}),
				...(signal !== undefined ? { signal } : {}),
				...(onUpdate !== undefined ? { onUpdate } : {}),
			});
			return deps.service.buildBatchToolResult(
				batch,
				params.tasks.map((t) => t.agent),
			);
		},
	};
}

function buildSubagentBatchSchema(profiles: SubagentProfile[]) {
	const names = profiles.map((p) => p.name);
	return Type.Object(
		{
			tasks: Type.Array(
				Type.Object(
					{
						agent: Type.Union(
							names.map((n) => Type.Literal(n)),
							{ description: "Sub-agent profile name. Must be one of the available profiles." },
						),
						task: Type.String({
							description:
								"Self-contained task description. The sub-agent does NOT see the parent conversation or siblings.",
						}),
						model: Type.Optional(
							Type.String({
								description:
									"Override the model id for this run. Defaults to the profile's model if set, else the parent's current model.",
							}),
						),
					},
					{ additionalProperties: false },
				),
				{
					minItems: 2,
					description:
						"Array of 2+ tasks to dispatch in parallel. For a single task, use the `subagent` tool instead.",
				},
			),
			failFast: Type.Optional(
				Type.Boolean({
					description:
						"When true, aborts in-flight siblings on the first child failure. Defaults to false (collect-all).",
				}),
			),
		},
		{ additionalProperties: false },
	);
}
