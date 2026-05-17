import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { AppShell } from "@bodhiapp/bodhi-pi-test-app-browser/client";
import { createHttpAdapter } from "../acp/adapter-http.ts";
import { createWsAdapter } from "../acp/adapter-ws.ts";

export default function App() {
	const { pathname } = useLocation();
	const isWs = pathname.startsWith("/ws");
	const adapter = useMemo(() => (isWs ? createWsAdapter() : createHttpAdapter()), [isWs]);
	return <AppShell title={isWs ? "bodhi-pi test-app-http (WS)" : "bodhi-pi test-app-http (HTTP)"} adapter={adapter} />;
}
