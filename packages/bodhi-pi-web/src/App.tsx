import { clearHandle } from "@bodhiapp/bodhi-pi-browser";
import { useEffect, useState } from "react";
import "./App.css";
import { clearLastSessionId } from "./agent/session-storage";
import { ChatPage } from "./ui/ChatPage";
import { DirectoryGate } from "./ui/DirectoryGate";
import { RuntimeProvider } from "./ui/RuntimeProvider";
import { type BootstrapResult, bootstrapWorkspace } from "./workspace/bootstrap";
import type { WorkspaceConfig } from "./workspace/types";

function App() {
	const [boot, setBoot] = useState<BootstrapResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		bootstrapWorkspace()
			.then((result) => {
				if (!cancelled) setBoot(result);
			})
			.catch((err) => {
				if (!cancelled) setError(String(err));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	function handleGranted(workspace: WorkspaceConfig) {
		setBoot({ ready: true, workspace });
	}

	async function handleUnmount() {
		// Forget the granted FSA handle and the per-tab session pointer; the
		// state flip below unmounts <RuntimeProvider> which terminates the
		// worker (ZenFS state goes with the realm). Dexie sessions persist
		// across unmounts but are filtered by cwd, so a remount of a
		// different folder starts with a clean /sessions list.
		await clearHandle();
		clearLastSessionId();
		setBoot({ ready: false, kind: "needs-pick" });
	}

	if (error) {
		return (
			<div data-testid="bootstrap-error" className="bootstrap-error">
				bootstrap failed: {error}
			</div>
		);
	}

	if (!boot) {
		return <div data-testid="bootstrap-loading" className="bootstrap-loading" />;
	}

	if (!boot.ready) {
		return (
			<DirectoryGate
				mode={boot.kind}
				pendingHandle={boot.kind === "needs-permission" ? boot.handle : undefined}
				pendingName={boot.kind === "needs-permission" ? boot.name : undefined}
				onGranted={handleGranted}
			/>
		);
	}

	return (
		<RuntimeProvider workspace={boot.workspace} onUnmount={handleUnmount}>
			<ChatPage />
		</RuntimeProvider>
	);
}

export default App;
