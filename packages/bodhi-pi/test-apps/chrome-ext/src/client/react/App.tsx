import { AppShell } from "@bodhiapp/bodhi-pi-test-app-browser/client";
import { createChromeExtAdapter } from "../acp/adapter.ts";

const adapter = createChromeExtAdapter();

export function App() {
	return <AppShell title="bodhi-pi test-app-chrome-ext" adapter={adapter} />;
}
