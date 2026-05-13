export default (pi) => {
	pi.registerCommand("ext-greet", {
		description: "Greet using an extension-supplied slash command.",
		template: "Reply with exactly the single word: hi",
	});
};
