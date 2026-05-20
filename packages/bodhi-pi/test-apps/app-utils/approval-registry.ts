import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

/**
 * Client-side pending-approval registry shared by every browser-runtime Host (browser, chrome-ext,
 * http-WS). It is the single channel behind the `requestPermission` round-trip: the Client's
 * `requestPermission` handler parks the request via `awaitVerdict`, and a composer-typed
 * `/approve`·`/reject` slash releases it via `resolve`. No UI modal — per `test-apps/CLAUDE.md`.
 *
 * Verdict → optionId mapping assumes the milestone-040 four-option set
 * (`allow_once`/`allow_always`/`reject_once`/`reject_always`). Unknown verdicts (or no pending
 * request) resolve to `cancelled`.
 */
export type ApprovalVerdict = "approve" | "reject";
export type ApprovalScope = "once" | "always";

export interface ApprovalRegistry {
	/** Park a `requestPermission` request; the returned promise resolves when a slash releases it. */
	awaitVerdict(req: RequestPermissionRequest): Promise<RequestPermissionResponse>;
	/** Release the pending request with a verdict. Returns false when nothing is pending. */
	resolve(verdict: ApprovalVerdict, scope: ApprovalScope): boolean;
	/** Resolve any pending request as cancelled (e.g. on session change). */
	cancel(): void;
	hasPending(): boolean;
}

export function createApprovalRegistry(): ApprovalRegistry {
	let pending: { options: PermissionOption[]; resolve: (r: RequestPermissionResponse) => void } | null = null;

	const optionIdFor = (options: PermissionOption[], verdict: ApprovalVerdict, scope: ApprovalScope): string | undefined => {
		const wanted = `${verdict === "approve" ? "allow" : "reject"}_${scope}`;
		return options.find((o) => o.optionId === wanted)?.optionId;
	};

	return {
		awaitVerdict(req) {
			return new Promise<RequestPermissionResponse>((resolve) => {
				pending = { options: req.options, resolve };
			});
		},
		resolve(verdict, scope) {
			if (!pending) return false;
			const optionId = optionIdFor(pending.options, verdict, scope);
			pending.resolve(
				optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } },
			);
			pending = null;
			return true;
		},
		cancel() {
			if (!pending) return;
			pending.resolve({ outcome: { outcome: "cancelled" } });
			pending = null;
		},
		hasPending() {
			return pending !== null;
		},
	};
}
