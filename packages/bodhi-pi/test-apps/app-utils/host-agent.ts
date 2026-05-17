import { type BodhiPiConfig, createBodhiPiAgent } from "@bodhiapp/bodhi-pi";
import { pickDefined } from "./pick-defined.js";

/**
 * Required adapter set every Host must supply (mandatory in `BodhiPiConfig`).
 */
export interface HostAgentRequired {
	sessionStore: BodhiPiConfig["sessionStore"];
	filesystem: BodhiPiConfig["filesystem"];
}

/**
 * All optional `BodhiPiConfig` fields. Hosts pass whatever subset they need; `undefined`
 * entries are stripped via `pickDefined` so the underlying factory's narrow types stay happy.
 */
export type HostAgentOptional = Partial<Omit<BodhiPiConfig, "sessionStore" | "filesystem">>;

/**
 * Thin wrapper around `createBodhiPiAgent` that lets each Reference Host supply its
 * `RuntimeAdapterSet` (required adapters + a bag of optional fields) without reinventing
 * the `pickDefined` boilerplate. The four Reference Hosts (cli, http, browser, chrome-ext)
 * still own their adapter wiring; this helper only normalises the final assembly step.
 *
 * Returns the agent factory unchanged — callers that need to wrap it (e.g. http's per-turn
 * cwd Proxy) compose around the returned value.
 */
export function createBodhiPiHostAgent(
	required: HostAgentRequired,
	optional?: HostAgentOptional,
): ReturnType<typeof createBodhiPiAgent> {
	return createBodhiPiAgent({
		sessionStore: required.sessionStore,
		filesystem: required.filesystem,
		...(pickDefined((optional ?? {}) as Record<string, unknown>) as HostAgentOptional),
	});
}
