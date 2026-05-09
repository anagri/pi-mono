export default function (pi) {
	pi.on("before_agent_start", (event) => {
		const rule = "Speak like a pirate. Use words like arr, matey, ye. Stay in character at all times.";
		const newSystem = event.systemPrompt ? event.systemPrompt + "\n\n" + rule : rule;
		return { systemPrompt: newSystem };
	});
}
