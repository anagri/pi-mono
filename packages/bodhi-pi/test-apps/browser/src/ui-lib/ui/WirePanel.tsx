import { WIRE_ROW_ATTRS } from "@bodhiapp/bodhi-pi";
import type { FrameEntry } from "../lib/frame-log.ts";

export interface WirePanelProps {
	frames: FrameEntry[];
}

export function WirePanel({ frames }: WirePanelProps) {
	return (
		<section className="wire-panel" data-testid="wire-panel">
			<header className="wire-panel-header">wire</header>
			<section className="frame-log" data-testid="frame-log">
				{frames.map((f) => (
					<div
						key={f.seq}
						data-testid="frame"
						{...{
							[WIRE_ROW_ATTRS.direction]: f.direction,
							[WIRE_ROW_ATTRS.kind]: f.kind,
							[WIRE_ROW_ATTRS.method]: f.method,
							[WIRE_ROW_ATTRS.rpcId]: f.rpcId,
							[WIRE_ROW_ATTRS.seq]: f.seq,
						}}
					>
						<pre>{f.payload}</pre>
					</div>
				))}
			</section>
		</section>
	);
}
