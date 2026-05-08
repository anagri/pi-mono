import { Type } from "typebox";
import type { ExtensionFactory, RegisteredExtension } from "@/index.js";

/**
 * Five canonical headless extension fixtures used at every layer of the test
 * matrix (core integration with faux LLMs, core e2e with gpt-4o-mini, CLI e2e,
 * web Playwright). Single source of truth → behavioural drift between layers
 * is impossible.
 *
 * NOTE: these factories receive the Headless `ExtensionAPI` only — no `ctx.ui.*`,
 * no shortcuts, no editor/footer/header/widget hooks. TUI primitives are
 * unsupported by design.
 */

/** input-transform: a `?quick` prefix becomes a directive forcing a one-line answer. */
export const inputTransform: ExtensionFactory = (pi) => {
	pi.on("input", (event) => {
		if (!event.text.startsWith("?quick ")) return;
		const stripped = event.text.slice("?quick ".length);
		return { text: `Reply with one short sentence (no preamble): ${stripped}` };
	});
};

/** pirate / prompt-customizer: appends a system-prompt rule forcing pirate voice. */
export const pirate: ExtensionFactory = (pi) => {
	pi.on("before_agent_start", (event) => {
		const rule = "Speak like a pirate. Use words like arr, matey, ye. Stay in character at all times.";
		const newSystem = event.systemPrompt ? `${event.systemPrompt}\n\n${rule}` : rule;
		return { systemPrompt: newSystem };
	});
};

/** redact-secrets: scrubs anything that looks like an API key out of tool results. */
export const redactSecrets: ExtensionFactory = (pi) => {
	pi.on("tool_result", (event) => {
		const newContent = event.result.content.map((block) => {
			if (block.type !== "text") return block;
			const cleaned = block.text.replace(/sk-[A-Za-z0-9_-]{6,}/g, "[REDACTED]");
			return cleaned === block.text ? block : { ...block, text: cleaned };
		});
		const changed = newContent.some((b, i) => b !== event.result.content[i]);
		return changed ? { content: newContent } : undefined;
	});
};

/**
 * dynamic-tools: registers a `bodhi_echo` tool. Registration happens at factory
 * load time (synchronously) so the tool is in the session-tool-set before the
 * first prompt; coding-agent's example uses the same pattern.
 */
export const dynamicTools: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "bodhi_echo",
		description: "Echo a message verbatim. Useful for testing tool-call dispatch.",
		parameters: Type.Object({
			message: Type.String({ description: "Text to echo back" }),
		}),
		execute: async (_id, params) => ({
			content: [{ type: "text", text: `echoed: ${params.message}` }],
			details: {},
		}),
	});
};

/**
 * register-provider: registers an additional Model<Api> via `pi.registerProvider`.
 *
 * Tests inject a Model+key pair via `makeRegisterProviderFactory(...)`. The integration
 * test uses a faux model so the agent's setSessionConfigOption + prompt dispatch can
 * be observed deterministically; the e2e test uses a real Anthropic Haiku model.
 */
export function makeRegisterProviderFactory(opts: {
	registrationName: string;
	model: import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api>;
	apiKey?: string;
}): ExtensionFactory {
	return (pi) => {
		pi.registerProvider(opts.registrationName, {
			model: opts.model,
			...(opts.apiKey !== undefined ? { getApiKey: () => opts.apiKey } : {}),
		});
	};
}

/** Helper to wrap a bare factory as a `RegisteredExtension`. */
export function asRegistered(name: string, factory: ExtensionFactory): RegisteredExtension {
	return { name, factory };
}
