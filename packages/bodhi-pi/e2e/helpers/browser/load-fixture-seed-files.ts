import fs from "node:fs/promises";
import path from "node:path";
import { fixtureBodhiPiDir } from "../seed-bodhi-pi.js";

export async function loadFixtureSeedFiles(
	fixture: string,
	opts: { getApiKey?: (provider: string) => string | undefined },
): Promise<Record<string, string>> {
	const root = fixtureBodhiPiDir(fixture);
	const out: Record<string, string> = {};
	async function walk(absDir: string, relDir: string): Promise<void> {
		const entries = await fs.readdir(absDir, { withFileTypes: true });
		for (const entry of entries) {
			const childAbs = path.join(absDir, entry.name);
			const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(childAbs, childRel);
			} else if (entry.isFile()) {
				out[`.bodhi-pi/${childRel}`] = await fs.readFile(childAbs, "utf-8");
			}
		}
	}
	await walk(root, "");
	// register-provider is shipped as a TypeScript package-mode extension —
	// the cli/http jiti loader handles it, but the browser extension loader
	// only picks flat .js/.mjs files. Generate a flat JS twin with the
	// anthropic API key baked in (read from the harness's getApiKey, which
	// is how Node's `process.env.ANTHROPIC_API_KEY` would have flowed in).
	if (fixture === "register-provider") {
		const apiKey = opts.getApiKey?.("anthropic") ?? process.env.ANTHROPIC_API_KEY ?? "";
		out[".bodhi-pi/extensions/register-provider.js"] =
			`// Auto-generated flat-JS twin of the TS package-mode register-provider
// extension for the browser e2e harness. The TS file under
// register-provider/src/index.ts continues to power cli/http/ws.
// Mirrors the runtime shape from pi-ai's claude-haiku-4-5 entry.
export default function registerAnthropicProvider(pi) {
  const apiKey = ${JSON.stringify(apiKey)};
  if (!apiKey) throw new Error("register-provider (browser): anthropic api key missing");
  const model = {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5 (latest)",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
  pi.registerProvider("ext-anthropic", { model, getApiKey: () => apiKey });
}
`;
	}
	return out;
}
