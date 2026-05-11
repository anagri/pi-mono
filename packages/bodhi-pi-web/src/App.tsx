import {
	type BootstrapResult,
	ChatPage,
	clearHandle,
	clearLastSessionId,
	DirectoryGate,
	EventsPanel,
	RuntimeProvider,
	type WorkspaceProvider,
	bootstrapWorkspace,
} from "@bodhiapp/bodhi-pi-browser";
import { useEffect, useState } from "react";
import "./App.css";
import { workerFactory } from "./agent/runtime";

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

	function handleGranted(workspace: WorkspaceProvider) {
		setBoot({ ready: true, workspace });
	}

	async function handleUnmount() {
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
		<RuntimeProvider workspace={boot.workspace} workerFactory={workerFactory} onUnmount={handleUnmount}>
			<div className="app-shell" data-testid="app-shell">
				<ChatPage />
				<EventsPanel />
			</div>
		</RuntimeProvider>
	);
}

export default App;
