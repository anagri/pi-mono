// DOM contract: the harness scrapes [data-testid="frame"] children of the
// frame log in `data-frame-seq` order. Each frame carries direction (out|in),
// kind (request|response|notification), method, rpc-id, and payload in the
// child <pre>.

export interface FrameEntry {
	seq: number;
	direction: "out" | "in";
	kind: "request" | "response" | "notification";
	method: string;
	rpcId: string;
	payload: string;
}

export interface EventEntry {
	seq: number;
	type: string;
	payload: string;
}
