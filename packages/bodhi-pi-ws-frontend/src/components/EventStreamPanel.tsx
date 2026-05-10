import { useMemo } from "react";
import type { EventLog, RawFrame } from "../lib/event-log";
import { useEventLog } from "../hooks/useEventLog";

interface ParsedFrame {
	method: string;
	kind: string;
	id: string;
}

function parseFrame(raw: string): ParsedFrame {
	try {
		const obj = JSON.parse(raw) as Record<string, unknown>;
		const method = typeof obj.method === "string" ? obj.method : obj.error ? "error" : obj.result ? "response" : "";
		let kind = "";
		const params = obj.params as Record<string, unknown> | undefined;
		if (params && typeof params === "object") {
			const update = params.update as Record<string, unknown> | undefined;
			if (update && typeof update.sessionUpdate === "string") {
				kind = update.sessionUpdate;
			}
		}
		const id = obj.id !== undefined ? String(obj.id) : "";
		return { method, kind, id };
	} catch {
		return { method: "", kind: "", id: "" };
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

interface EventRowProps {
	entry: RawFrame;
	index: number;
}

function EventRow({ entry, index }: EventRowProps) {
	const parsed = useMemo(() => parseFrame(entry.raw), [entry.raw]);
	const arrow = entry.direction === "inbound" ? "↓" : "↑";
	const label = parsed.method || (parsed.kind ? `update:${parsed.kind}` : "(frame)");

	return (
		<div
			data-testid="event-row"
			data-direction={entry.direction}
			data-method={parsed.method}
			data-kind={parsed.kind}
			data-rpc-id={parsed.id}
			data-ts={entry.ts}
			data-row-index={index}
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
				<strong style={{ color: entry.direction === "inbound" ? "#1a6f1a" : "#1a4f8a" }}>{label}</strong>
				{parsed.kind && parsed.kind !== label.replace(/^update:/, "") ? (
					<span style={{ color: "#888" }}>· {parsed.kind}</span>
				) : null}
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
}

interface EventStreamPanelProps {
	log: EventLog | null;
}

export function EventStreamPanel({ log }: EventStreamPanelProps) {
	const entries = useEventLog(log);

	if (!log) return null;

	return (
		<aside
			data-testid="event-stream-panel"
			data-event-count={entries.length}
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
				}}
			>
				<strong>Event stream</strong>
				<span data-testid="event-count" style={{ marginLeft: "0.5rem", color: "#666" }}>
					({entries.length} frames)
				</span>
			</header>
			<div style={{ overflow: "auto", flex: 1 }}>
				{entries.length === 0 ? (
					<div style={{ padding: "0.75rem", color: "#888", fontSize: "0.8rem" }}>(no frames yet)</div>
				) : null}
				{entries.map((entry, idx) => (
					<EventRow key={`${entry.ts}-${idx}`} entry={entry} index={idx} />
				))}
			</div>
		</aside>
	);
}
