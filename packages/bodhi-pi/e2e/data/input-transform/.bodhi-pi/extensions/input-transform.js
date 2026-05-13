export default (pi) => {
	pi.on("input", (event) => {
		if (!event.text.startsWith("?quick ")) return;
		const stripped = event.text.slice("?quick ".length);
		return { text: `Reply with one short sentence (no preamble): ${stripped}` };
	});
};
