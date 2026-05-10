import { useEffect, useState } from "react";
import type { EventLog, RawFrame } from "../lib/event-log";

export function useEventLog(log: EventLog | null): ReadonlyArray<RawFrame> {
	const [entries, setEntries] = useState<ReadonlyArray<RawFrame>>(() => log?.entries() ?? []);

	useEffect(() => {
		if (!log) {
			setEntries([]);
			return;
		}
		return log.subscribe((next) => setEntries(next));
	}, [log]);

	return entries;
}
