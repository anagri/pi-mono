import { RequestError } from "@agentclientprotocol/sdk";

export function validateSessionId(method: string, params: Record<string, unknown>): string {
	const sessionId = params.sessionId;
	if (typeof sessionId !== "string") {
		throw new RequestError(-32602, `${method}: sessionId must be a string`);
	}
	return sessionId;
}

export function optionalSessionId(params: Record<string, unknown>): string | undefined {
	const sessionId = params.sessionId;
	return typeof sessionId === "string" ? sessionId : undefined;
}

export function requireStringParam(method: string, params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new RequestError(-32602, `${method}: ${key} must be a non-empty string`);
	}
	return value;
}
