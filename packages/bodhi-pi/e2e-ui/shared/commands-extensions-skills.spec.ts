import { expect, test } from "../fixtures.ts";
import { loadScenario } from "../helpers/load-scenario.ts";
import { buildSeedXml } from "../helpers/seed-xml.ts";

test("commands-extensions-skills: /say-tuesday, /skill:say-hello, redact-secrets", async ({ startApp, chat, wire }) => {
	const files = {
		...loadScenario("commands-say-tuesday"),
		...loadScenario("skills-say-hello"),
		...loadScenario("extensions-redact-secrets"),
	};

	await startApp({ seedXml: buildSeedXml(files) });

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
	// observes them. Assert at the wire boundary (what the model sees) rather
	// than on the assistant's text — the model may or may not echo file content
	// verbatim, but the tool_result update is the redaction contract.
	await chat.send("Read the file leak.txt and tell me what it contains verbatim.");
	await chat.waitForIdle();
	const toolUpdates = wire.rows({ direction: "in", method: "session/update" });
	const updatesText = (await toolUpdates.allInnerTexts()).join("\n");
	expect(updatesText).toContain("[REDACTED]");
	expect(updatesText).not.toContain("sk-PLAINTEXTSECRETXYZ123");
});
