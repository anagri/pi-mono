import { useCallback, useEffect, useMemo, useState } from "react";
import { Chat } from "./components/Chat.tsx";
import { AcpHttpClient } from "./lib/acp-http-client.ts";
import { clearToken, decodeToken, encodeToken, loadStoredToken, storeToken, type UserCtx } from "./lib/auth.ts";

function readStoredUser(): UserCtx | undefined {
	const tok = loadStoredToken();
	if (!tok) return undefined;
	try {
		return decodeToken(tok);
	} catch {
		clearToken();
		return undefined;
	}
}

export default function App() {
	const [user, setUser] = useState<UserCtx | undefined>(() => readStoredUser());

	if (user) {
		return <SignedIn user={user} onSignOut={() => { clearToken(); setUser(undefined); }} />;
	}
	return (
		<LoginForm
			onSignedIn={(u) => {
				storeToken(encodeToken(u));
				setUser(u);
			}}
		/>
	);
}

function LoginForm(props: { onSignedIn: (user: UserCtx) => void }) {
	const [id, setId] = useState("1");
	const [email, setEmail] = useState("alice@example.com");
	const [error, setError] = useState<string | undefined>();

	function submit(e: React.FormEvent) {
		e.preventDefault();
		setError(undefined);
		const idNum = Number(id);
		if (!Number.isFinite(idNum) || idNum < 0) {
			setError("id must be a non-negative number");
			return;
		}
		if (email.length === 0) {
			setError("email must not be empty");
			return;
		}
		props.onSignedIn({ id: idNum, email });
	}

	return (
		<main style={{ maxWidth: 480, margin: "10vh auto", padding: "0 1rem" }}>
			<h1 style={{ marginBottom: "0.5rem" }}>bodhi-pi-http</h1>
			<p style={{ marginTop: 0, opacity: 0.75 }}>HTTP+SSE reference client. Sign in with any non-empty (id, email) pair.</p>
			<form onSubmit={submit} style={{ display: "grid", gap: "0.75rem", marginTop: "1.5rem" }}>
				<label style={{ display: "grid", gap: "0.25rem" }}>
					<span>User id</span>
					<input type="number" value={id} onChange={(e) => setId(e.target.value)} required />
				</label>
				<label style={{ display: "grid", gap: "0.25rem" }}>
					<span>Email</span>
					<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
				</label>
				{error ? <div style={{ color: "#c0392b" }}>{error}</div> : null}
				<button type="submit" style={{ justifySelf: "start" }}>Sign in</button>
			</form>
		</main>
	);
}

interface SessionRow {
	sessionId: string;
	cwd: string;
	updatedAt: string;
}

function SignedIn(props: { user: UserCtx; onSignOut: () => void }) {
	const tok = useMemo(() => encodeToken(props.user), [props.user]);
	const client = useMemo(() => new AcpHttpClient({ token: tok }), [tok]);
	const [agentInfo, setAgentInfo] = useState<{ name: string; version: string } | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [sessions, setSessions] = useState<SessionRow[]>([]);
	const [activeSessionId, setActiveSessionId] = useState<string | undefined>();

	const refresh = useCallback(async () => {
		try {
			const r = await client.listSessions({});
			setSessions(r.sessions);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [client]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const init = await client.initialize();
				if (cancelled) return;
				setAgentInfo(init.agentInfo);
				await refresh();
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [client, refresh]);

	async function createSession() {
		setError(undefined);
		try {
			const r = await client.newSession({});
			await refresh();
			setActiveSessionId(r.sessionId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function deleteSession(sessionId: string) {
		setError(undefined);
		try {
			await client.deleteSession(sessionId);
			if (activeSessionId === sessionId) setActiveSessionId(undefined);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<main style={{ maxWidth: 720, margin: "5vh auto", padding: "0 1rem" }}>
			<header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
				<h1 style={{ margin: 0 }}>bodhi-pi-http</h1>
				<div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
					<span style={{ opacity: 0.75 }}>
						{props.user.email} (id: {props.user.id})
					</span>
					<button type="button" onClick={props.onSignOut}>Sign out</button>
				</div>
			</header>
			{agentInfo ? (
				<p style={{ opacity: 0.6, marginTop: "0.5rem" }}>
					Connected to <strong>{agentInfo.name}</strong> v{agentInfo.version}
				</p>
			) : (
				<p style={{ opacity: 0.6 }}>Initializing…</p>
			)}
			{error ? <div style={{ color: "#c0392b", marginTop: "0.5rem" }}>Error: {error}</div> : null}

			<section style={{ marginTop: "1.5rem" }}>
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
					<h2 style={{ margin: 0 }}>Sessions</h2>
					<div style={{ display: "flex", gap: "0.5rem" }}>
						<button type="button" onClick={refresh}>Refresh</button>
						<button type="button" onClick={createSession}>New session</button>
					</div>
				</div>
				{sessions.length === 0 ? (
					<p style={{ opacity: 0.6 }}>No sessions yet. Click "New session" to create one.</p>
				) : (
					<ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
						{sessions.map((s) => (
							<li
								key={s.sessionId}
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
									padding: "0.5rem 0.75rem",
									borderBottom: "1px solid #e0e0e0",
									background: activeSessionId === s.sessionId ? "rgba(0,0,0,0.04)" : "transparent",
								}}
							>
								<button
									type="button"
									onClick={() => setActiveSessionId(s.sessionId)}
									style={{
										flex: 1,
										textAlign: "left",
										border: "none",
										background: "transparent",
										display: "grid",
										gap: "0.25rem",
										padding: 0,
									}}
								>
									<code style={{ fontSize: "0.85em" }}>{s.sessionId}</code>
									<span style={{ opacity: 0.6, fontSize: "0.85em" }}>
										{new Date(s.updatedAt).toLocaleString()} · {s.cwd}
									</span>
								</button>
								<button type="button" onClick={() => deleteSession(s.sessionId)}>Delete</button>
							</li>
						))}
					</ul>
				)}
			</section>

			{activeSessionId ? (
				<section style={{ marginTop: "1.5rem" }}>
					<h2 style={{ margin: "0 0 0.5rem" }}>Chat</h2>
					<Chat client={client} sessionId={activeSessionId} />
				</section>
			) : null}
		</main>
	);
}
