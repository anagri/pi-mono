import { type Api, getModel, type Model } from "@mariozechner/pi-ai";
import { expect, test } from "vitest";
import { createInMemoryFilesystem, type Filesystem } from "../src/index.js";
import { stdInitParams } from "../test/helpers/acp-constants.js";
import { requireEnv } from "../test/helpers/env.js";
import { createTestHarness } from "../test/helpers/harness.js";
import { chunkedAgentText } from "../test/helpers/notifications.js";

const PROVIDER = "openai";
const MODEL_ID = "gpt-4o-mini";
const CWD = "/proj";
const SKILLS_DIR = `${CWD}/.bodhi-pi/skills`;

async function seedSkill(fs: Filesystem, folder: string, content: string): Promise<void> {
	await fs.mkdir(`${SKILLS_DIR}/${folder}`, { recursive: true });
	await fs.writeTextFile(`${SKILLS_DIR}/${folder}/SKILL.md`, content);
}

function harness(model: Model<Api>, apiKey: string, filesystem: Filesystem) {
	return createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === PROVIDER ? apiKey : undefined),
		filesystem,
	});
}

test("/skill:<name> arg expands and reaches the model with the body", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const fs = createInMemoryFilesystem();
	await seedSkill(
		fs,
		"say-hello",
		"---\ndescription: Say hello to a person\n---\nWhen you receive a name from the user, reply with exactly the words: hello, <name>\nReplace <name> with the value the user supplied. Output nothing else.\n",
	);
	const h = harness(getModel(PROVIDER, MODEL_ID), apiKey, fs);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: CWD, mcpServers: [] });
	await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "/skill:say-hello world" }] });

	expect(chunkedAgentText(h.updates).toLowerCase()).toContain("hello, world");
});
