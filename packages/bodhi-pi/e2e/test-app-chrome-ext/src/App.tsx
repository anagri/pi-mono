import { AppShell } from "@e2e/app-utils/browser/ui/index.ts";
import { createChromeExtAdapter } from "./adapter.ts";

const adapter = createChromeExtAdapter();

export function App() {
	return <AppShell title="bodhi-pi test-app-chrome-ext" adapter={adapter} />;
}
