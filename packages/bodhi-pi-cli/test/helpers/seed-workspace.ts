import fs from "node:fs/promises";
import path from "node:path";

/**
 * Workspace seed fed into a Node tmpdir. Mirrors the shape used by
 * `bodhi-pi-web/e2e/helpers/seed.ts` so the same content can be written into
 * either an FSA-mounted ZenFS volume or a real Node filesystem with no
 * source-of-truth duplication.
 *
 * Keys in each section are paths relative to the section root. e.g.
 *   commands: { "echo.md": "..." }            → <cwd>/.bodhi-pi/commands/echo.md
 *   skills:   { "say-hello/SKILL.md": "..." } → <cwd>/.bodhi-pi/skills/say-hello/SKILL.md
 *   extensions: { "pirate.js": "..." }        → <cwd>/.bodhi-pi/extensions/pirate.js
 *   files: { "leak.txt": "..." }              → <cwd>/leak.txt
 */
export interface WorkspaceSeed {
	commands?: Record<string, string>;
	skills?: Record<string, string>;
	extensions?: Record<string, string>;
	files?: Record<string, string>;
}

export async function seedWorkspace(cwd: string, seed: WorkspaceSeed): Promise<void> {
	if (seed.commands) await writeUnder(path.join(cwd, ".bodhi-pi", "commands"), seed.commands);
	if (seed.skills) await writeUnder(path.join(cwd, ".bodhi-pi", "skills"), seed.skills);
	if (seed.extensions) await writeUnder(path.join(cwd, ".bodhi-pi", "extensions"), seed.extensions);
	if (seed.files) await writeUnder(cwd, seed.files);
}

async function writeUnder(root: string, files: Record<string, string>): Promise<void> {
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(root, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, body, "utf8");
	}
}

/**
 * Canonical seed-template bodies — kept in lockstep with
 * `packages/bodhi-pi-web/e2e/{commands,skills,extensions}.spec.ts`. When the
 * web side centralises its templates (per cli-node + browser-web review D.1),
 * point both files at one source.
 */
export const templates = {
	commands: {
		echo: [
			"---",
			"description: Echo a word",
			"argument-hint: <word>",
			"---",
			"Reply with exactly the single word: $1",
			"And nothing else.",
		].join("\n"),
		sayTuesday: [
			"---",
			"description: Say tuesday",
			"---",
			'Reply with exactly the single word "tuesday" and nothing else.',
		].join("\n"),
	},
	skills: {
		sayHello: [
			"---",
			"description: Say hello to a person",
			"---",
			"When you receive a name from the user, reply with exactly the words: hello, <name>",
			"Replace <name> with the value the user supplied. Output nothing else.",
		].join("\n"),
		hiddenDaysSkill: (scriptAbsolutePath: string) =>
			[
				"---",
				"description: Compute days between a YYYY-MM-DD birthday and the baseline date.",
				"disable-model-invocation: true",
				"---",
				`You have a JavaScript helper at ${scriptAbsolutePath}.`,
				"Call run_script with:",
				"",
				`- path: "${scriptAbsolutePath}"`,
				'- args: ["<YYYY-MM-DD>"] where the date comes from the user\'s message.',
				"",
				"Reply with exactly that integer and nothing else.",
			].join("\n"),
		hiddenDaysScript: [
			"const baseline = Date.UTC(2026, 4, 8);",
			'const ms = baseline - new Date(args[0] + "T00:00:00Z").getTime();',
			"console.log(Math.floor(ms / 86400000));",
		].join("\n"),
	},
	extensions: {
		// Standalone JS — matches the JS-only-extensions charter in skipped.md.
		redactSecrets: `export default function (pi) {
	pi.on("tool_result", (event) => {
		const newContent = event.result.content.map((b) =>
			b.type === "text" ? { ...b, text: b.text.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]") } : b
		);
		const changed = newContent.some((b, i) => b !== event.result.content[i]);
		return changed ? { content: newContent } : undefined;
	});
}
`,
		dynamicTools: `export default function (pi) {
	pi.registerTool({
		name: "bodhi_echo",
		description: "Echo a message verbatim. Useful for testing tool-call dispatch.",
		parameters: {
			type: "object",
			properties: { message: { type: "string", description: "Text to echo back" } },
			required: ["message"],
			additionalProperties: false,
		},
		execute: async (_id, params) => ({
			content: [{ type: "text", text: "echoed: " + params.message }],
			details: {},
		}),
	});
}
`,
		pirate: `export default function (pi) {
	pi.on("before_agent_start", (event) => {
		const rule = "Speak like a pirate. Use words like arr, matey, ye. Stay in character at all times.";
		const newSystem = event.systemPrompt ? event.systemPrompt + "\\n\\n" + rule : rule;
		return { systemPrompt: newSystem };
	});
}
`,
	},
};
