import { useEffect, useState } from "react";
import type { EventLog, RawFrame } from "../lib/event-log.ts";

export function useEventLog(log: EventLog | null): ReadonlyArray<RawFrame> {
	const [frames, setFrames] = useState<ReadonlyArray<RawFrame>>([]);
	useEffect(() => {
		if (!log) {
			setFrames([]);
			return;
		}
		return log.subscribe(setFrames);
	}, [log]);
	return frames;
}
