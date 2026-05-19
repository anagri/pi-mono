import type { BodhiPiEvent, BodhiPiEventType } from "./types.js";

export type EventPayload<T extends BodhiPiEventType> = Omit<Extract<BodhiPiEvent, { type: T }>, "type" | "serverTime">;

export function createEvent<T extends BodhiPiEventType>(
	type: T,
	payload: EventPayload<T>,
): Extract<BodhiPiEvent, { type: T }> {
	return { type, serverTime: Date.now(), ...payload } as Extract<BodhiPiEvent, { type: T }>;
}
