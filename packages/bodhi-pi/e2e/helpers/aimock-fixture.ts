import { LLMock } from "@copilotkit/aimock";

export interface AimockFixture {
	/** Base aimock URL without `/v1`; append it for openai-completions compatibility. */
	url: string;
	/** `auth/<provider>` ProviderAuth blob — pass to `addProvider`/`_bodhi-pi/kv/set`. */
	providerValue: { base_url: string };
	mock: LLMock;
	cleanup(): Promise<void>;
}

/**
 * Boot an aimock LLMock on an ephemeral port and return the wire payload needed
 * to point a provider at it via `/login <provider> base_url=...`. Caller registers
 * mock responses on `.mock` via `onMessage(pattern, response, opts)`; per-fixture
 * streaming profile (`tps`, `ttft`) is set on the response opts there.
 */
export async function startAimockProvider(): Promise<AimockFixture> {
	const mock = new LLMock({ port: 0 });
	await mock.start();
	return {
		url: mock.url,
		providerValue: { base_url: `${mock.url}/v1` },
		mock,
		cleanup: async () => {
			await mock.stop();
		},
	};
}
