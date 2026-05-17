import {
	type AgentSideConnection,
	type PromptRequest,
	type PromptResponse,
	RequestError,
} from "@agentclientprotocol/sdk";
import type { StopReason as PiStopReason } from "@earendil-works/pi-ai";
import { randomUUID } from "@/_internal/uuid.js";
import { expandPromptTemplate } from "@/commands/prompt-templates.js";
import type { EventDispatcher } from "@/events/dispatcher.js";
import type { StopReason } from "@/events/types.js";
import type { ModelRegistry } from "@/models/registry.js";
import { formatLocationHint } from "@/sessions/_shared.js";
import type { CompactionOrchestrator } from "@/sessions/compaction-orchestrator.js";
import type { SessionEntry } from "@/sessions/entries.js";
import type { SessionState } from "@/sessions/session-state.js";
import { expandSkillCommand } from "@/skills/invocation.js";
import { toolKindFor } from "@/tools/index.js";
import { MODEL_CONFIG_ID } from "@/wire/constants.js";
import { agentToolContentForAcp, mapStopReason } from "@/wire/converters.js";

type AppendEntry = (sessionId: string, session: SessionState, entry: SessionEntry) => Promise<void>;

export interface PromptLoopDeps {
	conn: AgentSideConnection;
	events: EventDispatcher;
	modelRegistry: ModelRegistry;
	compactionOrchestrator: CompactionOrchestrator;
	appendEntry: AppendEntry;
}

export async function runPromptLoop(
	deps: PromptLoopDeps,
	session: SessionState,
	params: PromptRequest,
): Promise<PromptResponse> {
	const { events, modelRegistry, compactionOrchestrator } = deps;
	if (session.runtime.currentModelId === null) {
		const models = await modelRegistry.allModels();
		throw new RequestError(
			-32603,
			models.length > 0
				? `no model selected; choose one of: ${models.map((m) => m.id).join(", ")} via setSessionConfigOption(${MODEL_CONFIG_ID}) or /model <id>`
				: `no models available; configure provider auth via /login <provider> <api-key> or _bodhi-pi/kv/set auth/<provider>`,
		);
	}

	const text = params.prompt
		.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("");
	const expandedText = expandPromptTemplate(expandSkillCommand(text, session.skills), session.commands);

	session.runtime.cancelled = false;
	session.runtime.overflowRecoveryAttempted = false;

	const sessionId = params.sessionId;

	const inputResult = await events.emitInput({ type: "input", sessionId, text: expandedText, source: "acp" });
	if (inputResult.handled) {
		return { stopReason: "end_turn", userMessageId: params.messageId ?? null };
	}

	const before = await events.emitBeforeAgentStart({
		type: "before_agent_start",
		sessionId,
		systemPrompt: session.runtime.piAgent.state.systemPrompt,
		userPrompt: inputResult.text,
	});
	if (before.systemPrompt !== session.runtime.piAgent.state.systemPrompt) {
		session.runtime.piAgent.state.systemPrompt = before.systemPrompt;
	}
	const promptText = before.userPrompt;

	await events.emit({ type: "agent_start", sessionId, userPrompt: promptText });

	const outcome: { stopReason?: PiStopReason; errorMessage?: string } = {};
	const unsubscribe = subscribeToAgent(deps, sessionId, session, outcome);

	const finishTurn = async (stopReason: StopReason | undefined, errorMessage: string | undefined): Promise<void> => {
		await events.emit({
			type: "agent_end",
			sessionId,
			...(stopReason !== undefined ? { stopReason } : {}),
			messages: session.runtime.piAgent.state.messages,
			...(errorMessage !== undefined ? { errorMessage } : {}),
		});
	};

	try {
		await session.runtime.piAgent.prompt(promptText);
		await session.runtime.piAgent.waitForIdle();
		if (session.runtime.cancelled) {
			await finishTurn("cancelled", outcome.errorMessage);
			return { stopReason: "cancelled", userMessageId: params.messageId ?? null };
		}
		if (outcome.stopReason === "error") {
			const recovered = await compactionOrchestrator.tryOverflowRecovery(
				sessionId,
				session,
				promptText,
				outcome,
				finishTurn,
			);
			if (recovered) {
				return { stopReason: "end_turn", userMessageId: params.messageId ?? null };
			}
			const errorMessage = outcome.errorMessage ?? "model error";
			await finishTurn(undefined, errorMessage);
			throw new RequestError(-32603, errorMessage);
		}
		const stopReason = mapStopReason(outcome.stopReason);
		await finishTurn(stopReason, undefined);
		await compactionOrchestrator.checkAutoCompact(sessionId, session);
		return { stopReason, userMessageId: params.messageId ?? null };
	} finally {
		unsubscribe();
	}
}

export function subscribeToAgent(
	deps: Pick<PromptLoopDeps, "conn" | "events" | "appendEntry">,
	sessionId: string,
	session: SessionState,
	outcome: { stopReason?: PiStopReason; errorMessage?: string },
): () => void {
	const { conn, events, appendEntry } = deps;
	return session.runtime.piAgent.subscribe(async (event) => {
		switch (event.type) {
			case "turn_start": {
				await events.emit({ type: "turn_start", sessionId });
				return;
			}
			case "turn_end": {
				await events.emit({
					type: "turn_end",
					sessionId,
					message: event.message,
					toolResults: event.toolResults,
				});
				return;
			}
			case "message_start": {
				await events.emit({ type: "message_start", sessionId, message: event.message });
				return;
			}
			case "message_update": {
				await events.emit({
					type: "message_update",
					sessionId,
					message: event.message,
					assistantMessageEvent: event.assistantMessageEvent,
				});
				if (event.assistantMessageEvent.type !== "text_delta") return;
				await conn.sessionUpdate({
					sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: event.assistantMessageEvent.delta },
					},
				});
				return;
			}
			case "tool_execution_start": {
				await events.emit({
					type: "tool_execution_start",
					sessionId,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				});
				await conn.sessionUpdate({
					sessionId,
					update: {
						sessionUpdate: "tool_call",
						toolCallId: event.toolCallId,
						title: `${event.toolName} ${formatLocationHint(event.args)}`.trim(),
						kind: toolKindFor(event.toolName),
						status: "in_progress",
						rawInput: event.args,
					},
				});
				return;
			}
			case "tool_execution_update": {
				await events.emit({
					type: "tool_execution_update",
					sessionId,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					partialResult: event.partialResult,
				});
				const partialContent = Array.isArray(event.partialResult?.content) ? event.partialResult.content : [];
				await conn.sessionUpdate({
					sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: event.toolCallId,
						status: "in_progress",
						content: agentToolContentForAcp(partialContent),
					},
				});
				return;
			}
			case "tool_execution_end": {
				await events.emit({
					type: "tool_execution_end",
					sessionId,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result: event.result,
					isError: event.isError,
				});
				const resultContent = Array.isArray(event.result?.content) ? event.result.content : [];
				await conn.sessionUpdate({
					sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: event.toolCallId,
						status: event.isError ? "failed" : "completed",
						content: agentToolContentForAcp(resultContent),
					},
				});
				return;
			}
			case "message_end": {
				await events.emit({ type: "message_end", sessionId, message: event.message });
				const message = event.message;
				if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return;
				if (message.role === "assistant") {
					outcome.stopReason = message.stopReason;
					outcome.errorMessage = message.errorMessage;
				}
				await appendEntry(sessionId, session, {
					type: "message",
					id: randomUUID(),
					parentId: session.runtime.leafId,
					timestamp: Date.now(),
					message,
				});
				return;
			}
		}
	});
}
