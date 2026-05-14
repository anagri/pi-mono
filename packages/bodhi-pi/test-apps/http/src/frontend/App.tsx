import { AppShell } from "@bodhiapp/bodhi-pi-test-app-browser/ui";
import { createHttpAdapter } from "./adapter-http.ts";

const adapter = createHttpAdapter();

export default function App() {
	return <AppShell title="bodhi-pi test-app-http (HTTP)" adapter={adapter} />;
}
