import { useEffect, useState } from "react";
import "./App.css";
import { type BootstrapResult, bootstrapWorkspace } from "./workspace/bootstrap";
import type { WorkspaceConfig } from "./workspace/types";
import { ChatPage } from "./ui/ChatPage";
import { DirectoryGate } from "./ui/DirectoryGate";
import { RuntimeProvider } from "./ui/RuntimeProvider";

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
		<RuntimeProvider workspace={boot.workspace}>
			<ChatPage />
		</RuntimeProvider>
	);
}

export default App;
