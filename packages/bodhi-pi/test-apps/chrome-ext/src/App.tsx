import { AppShell } from "@bodhiapp/bodhi-pi-test-app-browser/ui";
import { createChromeExtAdapter } from "./adapter.ts";

const adapter = createChromeExtAdapter();

export function App() {
	return <AppShell title="bodhi-pi test-app-chrome-ext" adapter={adapter} />;
}
