import { AppShell } from "@bodhiapp/bodhi-pi-test-app-browser/ui";
import { createWsAdapter } from "../adapter-ws.ts";

const adapter = createWsAdapter();

export default function WsApp() {
	return <AppShell title="bodhi-pi test-app-http (WS)" adapter={adapter} />;
}
