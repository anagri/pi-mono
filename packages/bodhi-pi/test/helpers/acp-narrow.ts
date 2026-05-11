import type { SessionConfigOption, SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { expect } from "vitest";
import type { BodhiPiEvent } from "@/index.js";

export type SelectOption = SessionConfigOption & { type: "select" };

/** Narrow a `SessionConfigOption` to the `select` shape, asserting on the way. */
export function asSelectOption(opt: SessionConfigOption | undefined): SelectOption {
	expect(opt, "expected a SessionConfigOption").toBeDefined();
	expect(opt?.type).toBe("select");
	return opt as SelectOption;
}

/**
 * Locate exactly one sessionUpdate notification of the given kind in the
 * captured `updates` array and return it narrowed to the matching variant.
 * Asserts on the way; failed lookups produce a vitest failure with a
 * meaningful diagnostic.
 */
export function findUpdateOfKind<K extends SessionUpdate["sessionUpdate"]>(
	updates: SessionNotification[],
	kind: K,
	sessionId?: string,
): Extract<SessionUpdate, { sessionUpdate: K }> {
	const candidates = updates.filter(
		(u) => u.update.sessionUpdate === kind && (sessionId === undefined || u.sessionId === sessionId),
	);
	expect(candidates.length, `expected exactly one ${kind} notification${sessionId ? ` for ${sessionId}` : ""}`).toBe(
		1,
	);
	return candidates[0].update as Extract<SessionUpdate, { sessionUpdate: K }>;
}

/** True when at least one sessionUpdate of the given kind is present. */
export function hasUpdateOfKind(
	updates: SessionNotification[],
	kind: SessionUpdate["sessionUpdate"],
	sessionId?: string,
): boolean {
	return updates.some(
		(u) => u.update.sessionUpdate === kind && (sessionId === undefined || u.sessionId === sessionId),
	);
}

/**
 * Locate the first event of the given discriminator in the recorder log and
 * narrow to that variant. Throws via vitest assertion if absent.
 */
export function findEventOfType<T extends BodhiPiEvent["type"]>(
	log: BodhiPiEvent[],
	type: T,
): Extract<BodhiPiEvent, { type: T }> {
	const hit = log.find((e) => e.type === type);
	expect(hit, `expected at least one ${type} event in recorder log`).toBeDefined();
	return hit as Extract<BodhiPiEvent, { type: T }>;
}

/** Locate ALL events of the given discriminator and narrow each. */
export function findEventsOfType<T extends BodhiPiEvent["type"]>(
	log: BodhiPiEvent[],
	type: T,
): Extract<BodhiPiEvent, { type: T }>[] {
	return log.filter((e) => e.type === type) as Extract<BodhiPiEvent, { type: T }>[];
}
