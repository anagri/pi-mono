import { AppShell } from "@e2e/app-utils/browser/ui/index.ts";
import { createBrowserAdapter } from "./adapter.ts";

const adapter = createBrowserAdapter();

export function App() {
	return <AppShell title="bodhi-pi test-app-browser" adapter={adapter} />;
}
