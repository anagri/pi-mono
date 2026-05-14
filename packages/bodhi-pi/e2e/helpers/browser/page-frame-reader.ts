/// <reference lib="dom" />
import type { Page } from "playwright";

// Bulk DOM reader over the test-app's frame-log + event-log contract
// (`data-testid="frame"` + `data-frame-*`, `data-testid="event"` +
// `data-event-*`). Read in a single `page.evaluate(...)` so high-frequency
// streaming polls stay cheap — one CDP round-trip per tick instead of one
// per element.

export interface FrameSnapshot {
	seq: number;
	direction: "out" | "in";
	kind: "request" | "response" | "notification";
	method: string;
	rpcId: string;
	payload: string;
}

export interface EventSnapshot {
	seq: number;
	type: string;
	payload: string;
}

/** Read frames strictly after `cursor`, sorted ascending. */
export async function readNewFrames(page: Page, cursor: number): Promise<FrameSnapshot[]> {
	const frames = await page.evaluate((after) => {
		const out: FrameSnapshot[] = [];
		const frameLog = document.querySelector('[data-testid="frame-log"]');
		if (!frameLog) return out;
		for (const el of Array.from(frameLog.querySelectorAll<HTMLElement>('[data-testid="frame"]'))) {
			const seq = Number(el.dataset.frameSeq ?? 0);
			if (seq <= after) continue;
			const pre = el.querySelector("pre");
			out.push({
				seq,
				direction: (el.dataset.frameDirection ?? "") as FrameSnapshot["direction"],
				kind: (el.dataset.frameKind ?? "") as FrameSnapshot["kind"],
				method: el.dataset.frameMethod ?? "",
				rpcId: el.dataset.frameRpcId ?? "",
				payload: pre?.textContent ?? "",
			});
		}
		return out;
	}, cursor);
	frames.sort((a, b) => a.seq - b.seq);
	return frames;
}

/** Read frames + events strictly after their respective cursors in a single RTT. */
export async function readNewFramesAndEvents(
	page: Page,
	frameCursor: number,
	eventCursor: number,
): Promise<{ frames: FrameSnapshot[]; events: EventSnapshot[] }> {
	const data = await page.evaluate(
		({ frameCursor: fc, eventCursor: ec }) => {
			const frames: FrameSnapshot[] = [];
			const events: EventSnapshot[] = [];
			const frameLog = document.querySelector('[data-testid="frame-log"]');
			if (frameLog) {
				for (const el of Array.from(frameLog.querySelectorAll<HTMLElement>('[data-testid="frame"]'))) {
					const seq = Number(el.dataset.frameSeq ?? 0);
					if (seq <= fc) continue;
					const pre = el.querySelector("pre");
					frames.push({
						seq,
						direction: (el.dataset.frameDirection ?? "") as FrameSnapshot["direction"],
						kind: (el.dataset.frameKind ?? "") as FrameSnapshot["kind"],
						method: el.dataset.frameMethod ?? "",
						rpcId: el.dataset.frameRpcId ?? "",
						payload: pre?.textContent ?? "",
					});
				}
			}
			const eventLog = document.querySelector('[data-testid="event-log"]');
			if (eventLog) {
				for (const el of Array.from(eventLog.querySelectorAll<HTMLElement>('[data-testid="event"]'))) {
					const seq = Number(el.dataset.eventSeq ?? 0);
					if (seq <= ec) continue;
					const pre = el.querySelector("pre");
					events.push({
						seq,
						type: el.dataset.eventType ?? "",
						payload: pre?.textContent ?? "",
					});
				}
			}
			return { frames, events };
		},
		{ frameCursor, eventCursor },
	);
	data.frames.sort((a, b) => a.seq - b.seq);
	data.events.sort((a, b) => a.seq - b.seq);
	return data;
}
