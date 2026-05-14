import { AppShell } from "@e2e/app-utils/browser/ui/index.ts";
import { createHttpAdapter } from "./adapter-http.ts";

const adapter = createHttpAdapter();

export default function App() {
	return <AppShell title="bodhi-pi test-app-http (HTTP)" adapter={adapter} />;
}
