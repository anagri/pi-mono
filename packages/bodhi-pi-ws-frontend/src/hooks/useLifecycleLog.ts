import { useEffect, useState } from "react";
import type { LifecycleEventRow, LifecycleLog } from "../lib/lifecycle-log";

export function useLifecycleLog(log: LifecycleLog | null): ReadonlyArray<LifecycleEventRow> {
	const [entries, setEntries] = useState<ReadonlyArray<LifecycleEventRow>>(() => log?.entries() ?? []);

	useEffect(() => {
		if (!log) {
			setEntries([]);
			return;
		}
		return log.subscribe((next) => setEntries(next));
	}, [log]);

	return entries;
}
