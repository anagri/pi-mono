/**
 * pirate — appends a pirate-voice rule to the system prompt before every
 * agent run. Demonstrates the `before_agent_start` event with mutation.
 *
 * Try in the chat:
 *   say hello in your own words
 *   what is the weather like today?
 *
 * Expect responses peppered with arr / matey / ye / ahoy.
 */
export default function (pi) {
	pi.on("before_agent_start", (event) => {
		const rule =
			"Speak like a pirate. Use words like arr, matey, ye. Stay in character at all times.";
		const newSystem = event.systemPrompt
			? `${event.systemPrompt}\n\n${rule}`
			: rule;
		return { systemPrompt: newSystem };
	});
}
