import { memo, useMemo, useState } from "react";
import { useEventLog } from "../hooks/useEventLog.ts";
import { useLifecycleLog } from "../hooks/useLifecycleLog.ts";
import type { EventLog, RawFrame } from "../lib/event-log.ts";
import type { LifecycleEventRow, LifecycleLog } from "../lib/lifecycle-log.ts";

type TabName = "lifecycle" | "wire";

interface EventsPanelProps {
	eventLog: EventLog | null;
	lifecycleLog: LifecycleLog | null;
}

interface ParsedWireFrame {
	method: string;
	kind: "request" | "response" | "notification" | "error" | "unknown";
	rpcId: string;
}

function parseWireFrame(raw: string): ParsedWireFrame {
	try {
		const obj = JSON.parse(raw) as Record<string, unknown>;
		const method = typeof obj.method === "string" ? obj.method : "";
		const rpcId = obj.id !== undefined && obj.id !== null ? String(obj.id) : "";
		let kind: ParsedWireFrame["kind"];
		if (obj.error !== undefined) kind = "error";
		else if (obj.result !== undefined) kind = "response";
		else if (method && obj.id !== undefined && obj.id !== null) kind = "request";
		else if (method) kind = "notification";
		else kind = "unknown";
		return { method, kind, rpcId };
	} catch {
		return { method: "", kind: "unknown", rpcId: "" };
	}
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	const ms = String(d.getMilliseconds()).padStart(3, "0");
	return `${hh}:${mm}:${ss}.${ms}`;
}

const LifecycleRow = memo(function LifecycleRow({ row }: { row: LifecycleEventRow }) {
	return (
		<div
			data-testid="event-row"
			data-event-source="lifecycle"
			data-event-type={row.type}
			{...(row.sessionId ? { "data-session-id": row.sessionId } : {})}
			{...(row.toolName ? { "data-tool-name": row.toolName } : {})}
			{...(row.userPrompt ? { "data-user-prompt": row.userPrompt } : {})}
			{...(row.stopReason ? { "data-stop-reason": row.stopReason } : {})}
			{...(row.fromModelId ? { "data-from-model-id": row.fromModelId } : {})}
			{...(row.toModelId ? { "data-to-model-id": row.toModelId } : {})}
			style={{
				borderBottom: "1px solid #eee",
				padding: "0.35rem 0.5rem",
				fontFamily: "ui-monospace, monospace",
				fontSize: "0.75rem",
				display: "flex",
				gap: "0.5rem",
				flexWrap: "wrap",
			}}
		>
			<strong>{row.type}</strong>
			{row.toolName ? <span>tool={row.toolName}</span> : null}
			{row.stopReason ? <span>stop={row.stopReason}</span> : null}
			{row.fromModelId && row.toModelId ? (
				<span>
					{row.fromModelId}→{row.toModelId}
				</span>
			) : null}
			{row.userPrompt ? <span style={{ color: "#666" }}>{row.userPrompt}</span> : null}
		</div>
	);
});

const WireRow = memo(function WireRow({ entry }: { entry: RawFrame }) {
	const parsed = useMemo(() => parseWireFrame(entry.raw), [entry.raw]);
	const arrow = entry.direction === "out" ? "↑" : "↓";
	const label =
		parsed.method ||
		(parsed.kind === "response" ? "(response)" : parsed.kind === "error" ? "(error)" : "(frame)");
	return (
		<div
			data-testid="event-row"
			data-event-source="wire"
			data-event-direction={entry.direction}
			data-event-method={parsed.method}
			data-event-kind={parsed.kind}
			data-rpc-id={parsed.rpcId}
			data-ts={entry.ts}
			style={{
				borderBottom: "1px solid #eee",
				padding: "0.35rem 0.5rem",
				fontFamily: "ui-monospace, monospace",
				fontSize: "0.75rem",
				display: "grid",
				gap: "0.15rem",
			}}
		>
			<div style={{ display: "flex", gap: "0.4rem", alignItems: "center", color: "#444" }}>
				<span style={{ width: "1ch", textAlign: "center" }}>{arrow}</span>
				<span style={{ color: "#888" }}>{formatTime(entry.ts)}</span>
				<strong style={{ color: entry.direction === "out" ? "#1a6f1a" : "#1a4f8a" }}>{label}</strong>
				{parsed.rpcId ? <span style={{ color: "#888" }}>· id={parsed.rpcId}</span> : null}
			</div>
			<pre
				data-testid="event-raw"
				style={{
					margin: 0,
					padding: "0.25rem 0.4rem",
					background: "#f7f7f9",
					borderRadius: 3,
					whiteSpace: "pre-wrap",
					wordBreak: "break-all",
					maxHeight: "6rem",
					overflow: "auto",
				}}
			>
				{entry.raw}
			</pre>
		</div>
	);
});

export function EventsPanel({ eventLog, lifecycleLog }: EventsPanelProps) {
	const [tab, setTab] = useState<TabName>("lifecycle");
	const wire = useEventLog(eventLog);
	const lifecycle = useLifecycleLog(lifecycleLog);

	if (!eventLog || !lifecycleLog) return null;

	const rowCount = tab === "lifecycle" ? lifecycle.length : wire.length;

	return (
		<aside
			data-testid="events-panel"
			data-active-tab={tab}
			style={{
				position: "fixed",
				top: 0,
				right: 0,
				bottom: 0,
				width: 420,
				borderLeft: "1px solid #ccc",
				background: "#fff",
				display: "flex",
				flexDirection: "column",
				boxShadow: "-2px 0 8px rgba(0,0,0,0.04)",
				zIndex: 10,
			}}
		>
			<header
				style={{
					padding: "0.5rem 0.75rem",
					borderBottom: "1px solid #ccc",
					background: "#f4f4f8",
					fontSize: "0.85rem",
					display: "flex",
					alignItems: "center",
					gap: "0.5rem",
				}}
			>
				<strong>Events</strong>
				<button
					type="button"
					data-testid="events-tab"
					data-tab-name="lifecycle"
					data-tab-active={String(tab === "lifecycle")}
					onClick={() => setTab("lifecycle")}
					style={{ padding: "0.15rem 0.5rem", fontWeight: tab === "lifecycle" ? 700 : 400 }}
				>
					lifecycle ({lifecycle.length})
				</button>
				<button
					type="button"
					data-testid="events-tab"
					data-tab-name="wire"
					data-tab-active={String(tab === "wire")}
					onClick={() => setTab("wire")}
					style={{ padding: "0.15rem 0.5rem", fontWeight: tab === "wire" ? 700 : 400 }}
				>
					wire ({wire.length})
				</button>
				<button
					type="button"
					data-testid="events-clear"
					onClick={() => {
						if (tab === "lifecycle") lifecycleLog.clear();
						else eventLog.clear();
					}}
					style={{ marginLeft: "auto" }}
				>
					clear
				</button>
			</header>
			<div data-testid="events-panel-body" data-row-count={rowCount} style={{ overflow: "auto", flex: 1 }}>
				{rowCount === 0 ? (
					<div style={{ padding: "0.75rem", color: "#888", fontSize: "0.8rem" }}>(no {tab} events yet)</div>
				) : null}
				{tab === "lifecycle"
					? lifecycle.map((row) => <LifecycleRow key={row.id} row={row} />)
					: wire.map((entry, idx) => <WireRow key={`${entry.ts}-${idx}`} entry={entry} />)}
			</div>
		</aside>
	);
}
