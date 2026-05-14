import { AppShell } from "@e2e/app-utils/browser/ui/index.ts";
import { createWsAdapter } from "../adapter-ws.ts";

const adapter = createWsAdapter();

export default function WsApp() {
	return <AppShell title="bodhi-pi test-app-http (WS)" adapter={adapter} />;
}
