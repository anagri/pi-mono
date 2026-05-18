import type { BodhiPiLogger } from "@/acp/agent.js";

export type DiscoveryArea = "subagent" | "skill" | "command";

export function discoveryWarn(
	logger: BodhiPiLogger | undefined,
	area: DiscoveryArea,
	filePath: string,
	reason: string,
): void {
	(logger ?? console).warn(`[bodhi-pi ${area} discovery] dropped ${filePath}: ${reason}`);
}

export function discoveryDirWarn(
	logger: BodhiPiLogger | undefined,
	area: DiscoveryArea,
	dir: string,
	reason: string,
): void {
	(logger ?? console).warn(`[bodhi-pi ${area} discovery] dir scan failed for ${dir}: ${reason}`);
}
