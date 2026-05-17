import { createBrowserAdapter } from "../acp/adapter.ts";
import { AppShell } from "../index.ts";

const adapter = createBrowserAdapter();

export function App() {
	return <AppShell title="bodhi-pi test-app-browser" adapter={adapter} />;
}
