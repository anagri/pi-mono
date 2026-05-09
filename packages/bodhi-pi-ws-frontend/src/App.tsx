import { useState } from "react";
import { connect, type Connection } from "./lib/transport";
import { useSettings } from "./hooks/useSettings";
import "./App.css";

type Status = "idle" | "connecting" | "connected" | "disconnected" | "unauthorized";

const SERVER_URL = (import.meta.env.VITE_WS_SERVER_URL as string | undefined) ?? "ws://localhost:8788/agent";

function App() {
  const { settings, update } = useSettings();
  const [status, setStatus] = useState<Status>("idle");
  const [agentName, setAgentName] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [connection, setConnection] = useState<Connection | null>(null);

  async function onConnect() {
    setError("");
    setAgentName("");
    setStatus("connecting");
    try {
      const c = await connect({
        url: SERVER_URL,
        user: settings.sendToken ? { id: settings.id, email: settings.email } : undefined,
        onClose: () => setStatus("disconnected"),
      });
      setConnection(c);
      const result = await c.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
      setAgentName(result.agentInfo?.name ?? "");
      setStatus("connected");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus(settings.sendToken ? "disconnected" : "unauthorized");
    }
  }

  function onDisconnect() {
    connection?.ws.close();
    setConnection(null);
    setStatus("disconnected");
  }

  return (
    <main style={{ maxWidth: 640, margin: "2rem auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>bodhi-pi WS frontend</h1>

      <section data-testid="settings" style={{ display: "grid", gap: "0.5rem", marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1rem" }}>Settings</h2>
        <label>
          Email
          <input
            data-testid="settings-email"
            type="email"
            value={settings.email}
            onChange={(e) => update("email", e.target.value)}
            style={{ width: "100%" }}
          />
        </label>
        <label>
          User id
          <input
            data-testid="settings-id"
            type="number"
            value={settings.id}
            onChange={(e) => update("id", Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </label>
        <label>
          <input
            data-testid="settings-sendToken"
            type="checkbox"
            checked={settings.sendToken}
            onChange={(e) => update("sendToken", e.target.checked)}
          />{" "}
          Send token on connect
        </label>
      </section>

      <section style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "1rem" }}>
        <button
          type="button"
          data-testid="connect"
          onClick={onConnect}
          disabled={status === "connecting" || status === "connected"}
        >
          Connect
        </button>
        <button
          type="button"
          data-testid="disconnect"
          onClick={onDisconnect}
          disabled={status !== "connected"}
        >
          Disconnect
        </button>
      </section>

      <section
        data-testid="status"
        data-status={status}
        data-agent-name={agentName}
        style={{ padding: "0.75rem", border: "1px solid #ccc", borderRadius: 4 }}
      >
        <div>
          Status: <strong data-testid="status-text">{status}</strong>
        </div>
        {agentName ? (
          <div>
            Agent: <span data-testid="agent-name">{agentName}</span>
          </div>
        ) : null}
        {error ? (
          <div data-testid="error" style={{ color: "crimson", marginTop: "0.5rem" }}>
            {error}
          </div>
        ) : null}
      </section>
    </main>
  );
}

export default App;
