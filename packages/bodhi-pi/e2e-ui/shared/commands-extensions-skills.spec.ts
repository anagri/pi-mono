import { expect, test } from "../fixtures.ts";
import { loadScenario } from "../helpers/load-scenario.ts";
import { buildSeedXml } from "../helpers/seed-xml.ts";

test("commands-extensions-skills: /say-tuesday, /skill:say-hello, redact-secrets", async ({
	gotoStart,
	setup,
	chat,
	uniqueUserId,
	configJson,
}) => {
	await gotoStart();

	const files = {
		...loadScenario("commands-say-tuesday"),
		...loadScenario("skills-say-hello"),
		...loadScenario("extensions-redact-secrets"),
	};

	await setup.fillAndSubmit({
		userId: uniqueUserId,
		email: `${uniqueUserId}@e2e-ui.test`,
		seedXml: buildSeedXml(files),
		configJson,
	});

	// Project command — listed in availableCommands, so the local dispatcher
	// falls through and the agent expands the template before the LLM sees it.
	await chat.send("/say-tuesday");
	await chat.waitForIdle();
	await expect(chat.lastMessage("assistant")).toContainText(/tuesday/i);

	// Skill — registered as `skill:say-hello`, also goes via agent expansion.
	await chat.send("/skill:say-hello world");
	await chat.waitForIdle();
	const helloReply = (await chat.lastMessage("assistant").innerText()).toLowerCase();
	expect(helloReply).toContain("hello");
	expect(helloReply).toContain("world");

	// Extension hooks tool_result and redacts `sk-...` secrets before the model
	// observes them. The assistant should echo the file content with [REDACTED]
	// substituted; the raw secret must never make it to assistant text.
	await chat.send("Read the file leak.txt and tell me what it contains verbatim.");
	await chat.waitForIdle();
	const assistantText = await chat.lastMessage("assistant").innerText();
	expect(assistantText).toContain("[REDACTED]");
	expect(assistantText).not.toContain("sk-PLAINTEXTSECRETXYZ123");
});
