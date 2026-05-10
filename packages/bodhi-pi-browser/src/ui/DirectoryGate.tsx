import { useState } from "react";
import { pickAndPersistDirectory, reGrantPermission } from "../workspace/bootstrap";
import type { WorkspaceProvider } from "../workspace/provider";

export interface DirectoryGateProps {
	mode: "needs-pick" | "needs-permission";
	pendingHandle?: FileSystemDirectoryHandle;
	pendingName?: string;
	onGranted: (workspace: WorkspaceProvider) => void;
}

/**
 * Boot gate shown when no folder is granted (or permission lapsed). The chat
 * surface stays unmounted until the user clicks Grant; this is also why
 * `requestPermission` calls live HERE — the FSA spec requires a user gesture.
 */
export function DirectoryGate({ mode, pendingHandle, pendingName, onGranted }: DirectoryGateProps) {
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);

	async function handlePick() {
		setError(undefined);
		setBusy(true);
		try {
			const ws = await pickAndPersistDirectory();
			if (!ws) {
				setError("Permission denied. Try again to grant access.");
				return;
			}
			onGranted(ws);
		} catch (err) {
			setError(`error: ${String(err)}`);
		} finally {
			setBusy(false);
		}
	}

	async function handleReGrant() {
		if (!pendingHandle || !pendingName) return;
		setError(undefined);
		setBusy(true);
		try {
			const ws = await reGrantPermission(pendingHandle, pendingName);
			if (!ws) {
				setError("Permission denied. Try again to grant access.");
				return;
			}
			onGranted(ws);
		} catch (err) {
			setError(`error: ${String(err)}`);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div data-testid="directory-gate" data-gate-mode={mode} className="directory-gate">
			<div className="directory-gate-card">
				<h1>bodhi-pi-web</h1>
				{mode === "needs-pick" ? (
					<>
						<p>The agent needs access to a local folder to read and write files.</p>
						<button
							type="button"
							data-testid="directory-gate-pick"
							className="directory-gate-button"
							onClick={handlePick}
							disabled={busy}
						>
							{busy ? "Granting…" : "Pick folder"}
						</button>
					</>
				) : (
					<>
						<p>
							Re-grant access to <code>{pendingName}</code> to continue.
						</p>
						<button
							type="button"
							data-testid="directory-gate-regrant"
							className="directory-gate-button"
							onClick={handleReGrant}
							disabled={busy}
						>
							{busy ? "Granting…" : "Re-grant access"}
						</button>
					</>
				)}
				{error ? (
					<p data-testid="directory-gate-error" className="directory-gate-error">
						{error}
					</p>
				) : null}
			</div>
		</div>
	);
}
