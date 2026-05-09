import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import { useCallback, useState } from "react";

export interface SessionRow {
	sessionId: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
}

interface UseSessionsArgs {
	conn: ClientSideConnection | null;
}

type ListCapable = {
	listSessions?: (params: object) => Promise<{ sessions: SessionRow[] }>;
	extMethod?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};

export function useSessions({ conn }: UseSessionsArgs) {
	const [rows, setRows] = useState<SessionRow[]>([]);
	const [error, setError] = useState<string>("");

	const refresh = useCallback(async () => {
		if (!conn) {
			setRows([]);
			return;
		}
		try {
			const c = conn as unknown as ListCapable;
			if (typeof c.listSessions !== "function") {
				setError("server does not support session/list");
				return;
			}
			const res = await c.listSessions({});
			setRows(res.sessions);
			setError("");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [conn]);

	const remove = useCallback(
		async (sessionId: string) => {
			if (!conn) return;
			try {
				const c = conn as unknown as ListCapable;
				if (typeof c.extMethod === "function") {
					await c.extMethod("_bodhi-pi/session/delete", { sessionId });
				}
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[conn, refresh],
	);

	return { rows, error, refresh, remove };
}
