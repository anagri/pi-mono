export default (pi) => {
	pi.registerTool({
		name: "bodhi_echo",
		description: "Echo a message verbatim. Useful for testing tool-call dispatch.",
		parameters: {
			type: "object",
			properties: {
				message: { type: "string", description: "Text to echo back" },
			},
			required: ["message"],
		},
		execute: async (_id, params) => ({
			content: [{ type: "text", text: `echoed: ${params.message}` }],
			details: {},
		}),
	});
};
