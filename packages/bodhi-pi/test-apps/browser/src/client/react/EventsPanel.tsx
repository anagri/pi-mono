import type { EventEntry } from "@bodhiapp/bodhi-pi-test-app-utils/transport-types";

export interface EventsPanelProps {
	events: EventEntry[];
}

export function EventsPanel({ events }: EventsPanelProps) {
	return (
		<section className="events-panel" data-testid="events-panel">
			<header className="events-panel-header">events</header>
			<section className="events-log" data-testid="event-log">
				{events.map((ev) => (
					<div key={ev.seq} data-testid="event" data-event-type={ev.type} data-event-seq={ev.seq}>
						<pre>{ev.payload}</pre>
					</div>
				))}
			</section>
		</section>
	);
}
