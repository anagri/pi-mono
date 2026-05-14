import { AppShell } from "../ui-lib/ui/index.ts";
import { createBrowserAdapter } from "./adapter.ts";

const adapter = createBrowserAdapter();

export function App() {
	return <AppShell title="bodhi-pi test-app-browser" adapter={adapter} />;
}
