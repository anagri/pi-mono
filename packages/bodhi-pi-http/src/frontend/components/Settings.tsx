import type { Settings as SettingsValue } from "../hooks/useSettings.ts";

export function Settings(props: {
	settings: SettingsValue;
	update: <K extends keyof SettingsValue>(key: K, value: SettingsValue[K]) => void;
	onConnect: () => void;
	onDisconnect: () => void;
	connected: boolean;
}) {
	return (
		<section style={{ display: "grid", gap: "0.75rem" }}>
			<h2 style={{ margin: 0 }}>Settings</h2>
			<label style={{ display: "grid", gap: "0.25rem" }}>
				<span>User id</span>
				<input
					type="number"
					data-testid="settings-id"
					value={props.settings.id}
					disabled={props.connected}
					onChange={(e) => props.update("id", Number(e.target.value))}
				/>
			</label>
			<label style={{ display: "grid", gap: "0.25rem" }}>
				<span>Email</span>
				<input
					type="email"
					data-testid="settings-email"
					value={props.settings.email}
					disabled={props.connected}
					onChange={(e) => props.update("email", e.target.value)}
				/>
			</label>
			<label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
				<input
					type="checkbox"
					data-testid="settings-sendToken"
					checked={props.settings.sendToken}
					disabled={props.connected}
					onChange={(e) => props.update("sendToken", e.target.checked)}
				/>
				<span>Send token (uncheck to test unauthorized state)</span>
			</label>
			{props.connected ? (
				<button type="button" data-testid="disconnect" onClick={props.onDisconnect}>
					Disconnect
				</button>
			) : (
				<button type="button" data-testid="connect" onClick={props.onConnect}>
					Connect
				</button>
			)}
		</section>
	);
}
