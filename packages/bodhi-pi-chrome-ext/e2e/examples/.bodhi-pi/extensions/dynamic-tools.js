/**
 * dynamic-tools — registers a custom `bodhi_echo` LLM-callable tool that
 * echoes whatever message you give it. Demonstrates `pi.registerTool`.
 *
 * The schema is a plain JSON-Schema object; in a Node host you could use
 * TypeBox builders (`Type.Object(...)`) instead, but the browser loader
 * runs the file as data-URL ESM with no module resolution, so a literal is
 * the most portable form.
 *
 * Try in the chat:
 *   call the bodhi_echo tool with the message "hello from the browser"
 *     and report what it returned
 *
 * Expect a tool-call card showing `echoed: hello from the browser`.
 */
export default function (pi) {
	pi.registerTool({
		name: "bodhi_echo",
		description: "Echo a message verbatim. Useful for testing tool-call dispatch.",
		parameters: {
			type: "object",
			properties: {
				message: { type: "string", description: "Text to echo back" },
			},
			required: ["message"],
			additionalProperties: false,
		},
		execute: async (_id, params) => ({
			content: [{ type: "text", text: `echoed: ${params.message}` }],
			details: {},
		}),
	});
}
