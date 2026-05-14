import { loadScenario } from "./load-scenario.ts";
import { buildSeedXml } from "./seed-xml.ts";

export function scenarioSeedXml(name: string): string {
	return buildSeedXml(loadScenario(name));
}
