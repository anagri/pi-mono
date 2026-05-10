/**
 * input-transform — when the user prompt starts with `?quick `, rewrite it
 * into a directive that forces a one-sentence answer from the model.
 *
 * Try in the chat:
 *   ?quick what is 2 + 2
 *   ?quick give me a fun fact about octopuses
 *
 * The rewritten text is what the LLM actually sees, so the response stays
 * short. Without the prefix, your message is passed through unchanged.
 */
export default function (pi) {
	pi.on("input", (event) => {
		if (!event.text.startsWith("?quick ")) return;
		const stripped = event.text.slice("?quick ".length);
		return { text: `Reply with one short sentence (no preamble): ${stripped}` };
	});
}
