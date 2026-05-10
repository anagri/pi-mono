import { useEffect, useState } from "react";
import type { LifecycleEventRow, LifecycleLog } from "../lib/lifecycle-log.ts";

export function useLifecycleLog(log: LifecycleLog | null): ReadonlyArray<LifecycleEventRow> {
	const [rows, setRows] = useState<ReadonlyArray<LifecycleEventRow>>([]);
	useEffect(() => {
		if (!log) {
			setRows([]);
			return;
		}
		return log.subscribe(setRows);
	}, [log]);
	return rows;
}
