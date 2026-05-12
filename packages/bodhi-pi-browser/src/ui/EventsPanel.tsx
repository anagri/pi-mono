import { memo, useState } from "react";
import { type LifecycleEventRow, useEventStore, type WireEventRow } from "../store/eventStore";

type TabName = "lifecycle" | "wire";

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
			{...(row.fromModelId !== undefined
				? { "data-from-model-id": row.fromModelId === null ? "" : row.fromModelId }
				: {})}
			{...(row.toModelId ? { "data-to-model-id": row.toModelId } : {})}
			className="event-row event-row-lifecycle"
		>
			<span className="event-row-type">{row.type}</span>
			{row.toolName ? <span className="event-row-extra">tool={row.toolName}</span> : null}
			{row.stopReason ? <span className="event-row-extra">stop={row.stopReason}</span> : null}
			{row.fromModelId !== undefined && row.toModelId ? (
				<span className="event-row-extra">
					{row.fromModelId ?? "(none)"}→{row.toModelId}
				</span>
			) : null}
			{row.userPrompt ? <span className="event-row-prompt">{row.userPrompt}</span> : null}
		</div>
	);
});

const WireRow = memo(function WireRow({ row }: { row: WireEventRow }) {
	const arrow = row.direction === "in" ? "↓" : "↑";
	const label = row.method || (row.kind === "response" ? "(response)" : row.kind === "error" ? "(error)" : "(frame)");
	return (
		<div
			data-testid="event-row"
			data-event-source="wire"
			data-event-direction={row.direction}
			data-event-kind={row.kind}
			data-event-method={row.method}
			data-rpc-id={row.rpcId}
			className={`event-row event-row-wire event-row-wire-${row.direction}`}
		>
			<div className="event-row-header">
				<span className="event-row-arrow">{arrow}</span>
				<span className="event-row-type">{label}</span>
				{row.rpcId ? <span className="event-row-extra">id={row.rpcId}</span> : null}
			</div>
			<pre className="event-row-payload">{row.payload}</pre>
		</div>
	);
});

export function EventsPanel() {
	const [tab, setTab] = useState<TabName>("lifecycle");
	const lifecycle = useEventStore((s) => s.lifecycle);
	const wire = useEventStore((s) => s.wire);
	const clear = useEventStore((s) => s.clear);
	const rows = tab === "lifecycle" ? lifecycle : wire;

	return (
		<aside data-testid="events-panel" data-active-tab={tab} className="events-panel">
			<header className="events-panel-header">
				<strong>Events</strong>
				<div className="events-panel-tabs">
					<button
						type="button"
						data-testid="events-tab"
						data-tab-name="lifecycle"
						data-tab-active={String(tab === "lifecycle")}
						className={`events-panel-tab${tab === "lifecycle" ? " events-panel-tab-active" : ""}`}
						onClick={() => setTab("lifecycle")}
					>
						lifecycle ({lifecycle.length})
					</button>
					<button
						type="button"
						data-testid="events-tab"
						data-tab-name="wire"
						data-tab-active={String(tab === "wire")}
						className={`events-panel-tab${tab === "wire" ? " events-panel-tab-active" : ""}`}
						onClick={() => setTab("wire")}
					>
						wire ({wire.length})
					</button>
				</div>
				<button
					type="button"
					data-testid="events-clear"
					className="events-panel-clear"
					onClick={() => clear()}
				>
					clear
				</button>
			</header>
			<div className="events-panel-body" data-testid="events-panel-body" data-row-count={rows.length}>
				{rows.length === 0 ? <div className="events-panel-empty">(no {tab} events yet)</div> : null}
				{tab === "lifecycle"
					? lifecycle.map((row) => <LifecycleRow key={row.id} row={row} />)
					: wire.map((row) => <WireRow key={row.id} row={row} />)}
			</div>
		</aside>
	);
}
