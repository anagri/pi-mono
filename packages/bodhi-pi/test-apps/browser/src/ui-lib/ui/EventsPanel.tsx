import type { EventEntry } from "../lib/frame-log.ts";

export interface EventsPanelProps {
	events: EventEntry[];
}

export function EventsPanel({ events }: EventsPanelProps) {
	return (
		<section data-testid="events-panel">
			<section data-testid="event-log">
				{events.map((ev) => (
					<div key={ev.seq} data-testid="event" data-event-type={ev.type} data-event-seq={ev.seq}>
						<pre>{ev.payload}</pre>
					</div>
				))}
			</section>
		</section>
	);
}
