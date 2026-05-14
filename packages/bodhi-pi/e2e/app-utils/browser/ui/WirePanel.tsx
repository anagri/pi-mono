import type { FrameEntry } from "../lib/frame-log.ts";

export interface WirePanelProps {
	frames: FrameEntry[];
}

export function WirePanel({ frames }: WirePanelProps) {
	return (
		<section data-testid="wire-panel">
			<section data-testid="frame-log">
				{frames.map((f) => (
					<div
						key={f.seq}
						data-testid="frame"
						data-frame-direction={f.direction}
						data-frame-kind={f.kind}
						data-frame-method={f.method}
						data-frame-rpc-id={f.rpcId}
						data-frame-seq={f.seq}
					>
						<pre>{f.payload}</pre>
					</div>
				))}
			</section>
		</section>
	);
}
