export function setup(): void {
	if (!process.env.OPENAI_API_KEY) {
		throw new Error("OPENAI_API_KEY must be set in e2e/.env.test to run e2e tests");
	}
}
