import type { AvailableCommand, ClientSideConnection, SessionConfigOption } from "@agentclientprotocol/sdk";
import {
	EXT_MCP_ADD,
	EXT_MCP_CONNECT,
	EXT_MCP_DISCONNECT,
	EXT_MCP_EXCLUDE,
	EXT_MCP_INCLUDE,
	EXT_MCP_LIST,
	EXT_MCP_OAUTH_FINISH,
	EXT_MCP_OAUTH_START,
	EXT_MCP_RECONNECT,
	EXT_MCP_REMOVE,
	EXT_MCP_TOOLS,
	parseMcpAddArgs,
} from "@bodhiapp/bodhi-pi";

/**
 * Local slash dispatcher for the shared test-app UI. Operates on the raw
 * `ClientSideConnection` (not the publishable `BodhiPiClient`) so it stays
 * importable from the `e2e/` tree without violating the no-sibling-package
 * rule documented in `packages/bodhi-pi/e2e/CLAUDE.md`.
 *
 * Precedence rule:
 *   1. Non-slash → caller forwards to session/prompt.
 *   2. Slash whose name is in `availableCommands` → agent-side; caller forwards.
 *   3. Slash whose name is in this registry → handled locally here.
 *   4. Unknown slash → caller forwards verbatim (agent treats as literal text).
 */

const MODEL_CONFIG_ID = "model";
const EXT_SESSION_FORK = "_bodhi-pi/session/fork";
const EXT_SESSION_CLONE = "_bodhi-pi/session/clone";

export interface SlashState {
	sessionId: string;
	availableCommands: AvailableCommand[];
}

export interface SlashContext {
	conn: ClientSideConnection;
	cwd: string;
	state: SlashState;
	pushSystemMessage(text: string, dataAttrs?: Record<string, string>): void;
	setSessionId(id: string): void;
	setCurrentModel(id: string): void;
}

export type SlashOutcome = { handled: boolean };

/** Subset of `chrome.identity` we touch for oauth-preregistered in chrome-ext (typed locally to avoid @types/chrome dep). */
interface ChromeIdentityAPI {
	launchWebAuthFlow?(opts: { url: string; interactive: boolean }, cb: (responseUrl?: string) => void): void;
	getRedirectURL?(path?: string): string;
}

export function isSlash(line: string): boolean {
	return line.trim().startsWith("/");
}

function commandName(line: string): string {
	const head = line.trim().split(/\s+/, 1)[0] ?? "";
	return head.startsWith("/") ? head.slice(1) : head;
}

export function extractModelFromConfigOptions(options: SessionConfigOption[] | null | undefined): string | undefined {
	if (!options) return undefined;
	for (const opt of options) {
		if (opt.id === MODEL_CONFIG_ID && typeof opt.currentValue === "string") return opt.currentValue;
	}
	return undefined;
}

export async function tryHandleSlash(line: string, ctx: SlashContext): Promise<SlashOutcome> {
	if (!isSlash(line)) return { handled: false };
	const name = commandName(line);
	if (ctx.state.availableCommands.some((c) => c.name === name)) return { handled: false };

	const parts = line.trim().split(/\s+/);
	const cmd = parts[0];

	switch (cmd) {
		case "/model": {
			const modelId = parts[1];
			if (!modelId) {
				ctx.pushSystemMessage("usage: /model <id>");
				return { handled: true };
			}
			try {
				const result = await ctx.conn.setSessionConfigOption({
					sessionId: ctx.state.sessionId,
					configId: MODEL_CONFIG_ID,
					value: modelId,
				});
				const next = extractModelFromConfigOptions(result.configOptions);
				if (next) ctx.setCurrentModel(next);
				ctx.pushSystemMessage(`model switched to: ${next ?? modelId}`);
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/sessions": {
			try {
				const result = await ctx.conn.listSessions({ cwd: ctx.cwd });
				if (result.sessions.length === 0) {
					ctx.pushSystemMessage("(no sessions for this cwd)");
				} else {
					const lines = ["sessions:"];
					for (const s of result.sessions) {
						const marker = s.sessionId === ctx.state.sessionId ? "*" : " ";
						lines.push(`${marker} ${s.sessionId}`);
					}
					ctx.pushSystemMessage(lines.join("\n"));
				}
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/new": {
			try {
				if (ctx.state.sessionId) {
					try {
						await ctx.conn.closeSession({ sessionId: ctx.state.sessionId });
					} catch {
						// best-effort — don't block /new on a stale session
					}
				}
				const result = await ctx.conn.newSession({ cwd: ctx.cwd, mcpServers: [] });
				ctx.setSessionId(result.sessionId);
				const m = extractModelFromConfigOptions(result.configOptions);
				if (m) ctx.setCurrentModel(m);
				ctx.pushSystemMessage(`new session: ${result.sessionId}`);
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/resume": {
			const targetId = parts[1];
			if (!targetId) {
				ctx.pushSystemMessage("usage: /resume <session-id>");
				return { handled: true };
			}
			try {
				if (ctx.state.sessionId && ctx.state.sessionId !== targetId) {
					try {
						await ctx.conn.closeSession({ sessionId: ctx.state.sessionId });
					} catch {
						// best-effort
					}
				}
				const result = await ctx.conn.loadSession({ sessionId: targetId, cwd: ctx.cwd, mcpServers: [] });
				ctx.setSessionId(targetId);
				const m = extractModelFromConfigOptions(result.configOptions);
				if (m) ctx.setCurrentModel(m);
				ctx.pushSystemMessage(`resumed session: ${targetId}`, {
					"data-session-event": "resumed",
					"data-session-id": targetId,
				});
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/close": {
			try {
				await ctx.conn.closeSession({ sessionId: ctx.state.sessionId });
				ctx.pushSystemMessage(`closed session: ${ctx.state.sessionId}`, {
					"data-session-event": "closed",
					"data-session-id": ctx.state.sessionId,
				});
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/fork": {
			const entryId = parts[1];
			if (!entryId) {
				ctx.pushSystemMessage("usage: /fork <entry-id>");
				return { handled: true };
			}
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_FORK, {
					sessionId: ctx.state.sessionId,
					entryId,
					position: "before",
				})) as { newSessionId?: string };
				ctx.pushSystemMessage(`forked: ${result.newSessionId ?? ""}`);
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/clone": {
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_CLONE, {
					sessionId: ctx.state.sessionId,
				})) as { newSessionId?: string };
				ctx.pushSystemMessage(`cloned: ${result.newSessionId ?? ""}`, {
					"data-session-event": "cloned",
					"data-session-id": result.newSessionId ?? "",
				});
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/mcps": {
			try {
				const result = (await ctx.conn.extMethod(EXT_MCP_LIST, {})) as {
					entries: Array<{ slug: string; status: string; transport: string; url?: string; command?: string }>;
				};
				if (!result.entries || result.entries.length === 0) {
					ctx.pushSystemMessage("(no MCPs configured)", { "data-mcp-event": "list-empty" });
				} else {
					const lines = ["mcps:"];
					for (const e of result.entries) {
						lines.push(`  ${e.slug}  ${e.status}  ${e.transport}  ${e.url ?? e.command ?? ""}`);
					}
					ctx.pushSystemMessage(lines.join("\n"), {
						"data-mcp-event": "list",
						"data-mcp-count": String(result.entries.length),
					});
				}
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/mcp": {
			const sub = parts[1];
			const rest = parts.slice(2);
			return await handleMcpSubcommand(sub, rest, ctx);
		}

		default:
			return { handled: false };
	}
}

async function handleMcpSubcommand(
	sub: string | undefined,
	rest: string[],
	ctx: SlashContext,
): Promise<SlashOutcome> {
	try {
		if (sub === "add") {
			const args = parseMcpAddArgs(rest);
			if (args.error || !args.value) {
				ctx.pushSystemMessage(args.error ?? "missing argument");
				return { handled: true };
			}
			const result = (await ctx.conn.extMethod(EXT_MCP_ADD, args.value)) as { slug: string };
			ctx.pushSystemMessage(`added: ${result.slug}`, {
				"data-mcp-event": "added",
				"data-mcp-slug": result.slug,
			});
			return { handled: true };
		}
		const slug = rest[0];
		if (!sub || !slug) {
			ctx.pushSystemMessage("usage: /mcp <add|connect|disconnect|reconnect|remove|include|exclude|tools> [args…]");
			return { handled: true };
		}
		if (sub === "connect") {
			const result = (await ctx.conn.extMethod(EXT_MCP_CONNECT, { slug })) as { tools: string[] };
			ctx.pushSystemMessage(`connected ${slug}: ${result.tools.join(", ") || "(no tools)"}`, {
				"data-mcp-event": "connected",
				"data-mcp-slug": slug,
				"data-mcp-tool-count": String(result.tools.length),
			});
		} else if (sub === "disconnect") {
			await ctx.conn.extMethod(EXT_MCP_DISCONNECT, { slug });
			ctx.pushSystemMessage(`disconnected ${slug}`, {
				"data-mcp-event": "disconnected",
				"data-mcp-slug": slug,
			});
		} else if (sub === "reconnect") {
			const result = (await ctx.conn.extMethod(EXT_MCP_RECONNECT, { slug })) as { tools: string[] };
			ctx.pushSystemMessage(`reconnected ${slug}: ${result.tools.join(", ") || "(no tools)"}`, {
				"data-mcp-event": "reconnected",
				"data-mcp-slug": slug,
			});
		} else if (sub === "remove") {
			await ctx.conn.extMethod(EXT_MCP_REMOVE, { slug });
			ctx.pushSystemMessage(`removed ${slug}`, {
				"data-mcp-event": "removed",
				"data-mcp-slug": slug,
			});
		} else if (sub === "include") {
			const result = (await ctx.conn.extMethod(EXT_MCP_INCLUDE, {
				sessionId: ctx.state.sessionId,
				slug,
			})) as { tools: string[] };
			ctx.pushSystemMessage(`included ${slug}: ${result.tools.join(", ") || "(no tools visible)"}`, {
				"data-mcp-event": "included",
				"data-mcp-slug": slug,
				"data-mcp-tool-count": String(result.tools.length),
			});
		} else if (sub === "exclude") {
			await ctx.conn.extMethod(EXT_MCP_EXCLUDE, { sessionId: ctx.state.sessionId, slug });
			ctx.pushSystemMessage(`excluded ${slug}`, {
				"data-mcp-event": "excluded",
				"data-mcp-slug": slug,
			});
		} else if (sub === "oauth") {
			// `/mcp oauth start <slug> [--auto]` — kicks the oauth-preregistered flow.
			// Two paths: chrome-ext (chrome.identity.launchWebAuthFlow) or regular browser
			// (window.open popup + postMessage). Detected at runtime via chrome.identity presence.
			const action = rest[0];
			const oauthSlug = rest[1];
			const auto = rest.slice(2).includes("--auto");
			if (action !== "start" || !oauthSlug) {
				ctx.pushSystemMessage("usage: /mcp oauth start <slug> [--auto]");
				return { handled: true };
			}
			const chromeIdentity = (globalThis as { chrome?: { identity?: ChromeIdentityAPI } }).chrome?.identity;
			const useChromeIdentity = typeof chromeIdentity?.launchWebAuthFlow === "function";
			const redirectUri = useChromeIdentity
				? chromeIdentity!.getRedirectURL!()
				: `${window.location.origin}/oauth/callback`;
			const startResp = (await ctx.conn.extMethod(EXT_MCP_OAUTH_START, {
				slug: oauthSlug,
				redirectUri,
			})) as { authorizeUrl?: string; state?: string; status?: string };
			if (startResp.status === "completed") {
				ctx.pushSystemMessage(`oauth: already authorized ${oauthSlug}`, {
					"data-mcp-event": "oauth-completed",
					"data-mcp-slug": oauthSlug,
				});
				return { handled: true };
			}
			const urlToOpen = auto ? `${startResp.authorizeUrl}&auto=1` : startResp.authorizeUrl!;
			let cbCode: string;
			let cbState: string;
			if (useChromeIdentity) {
				ctx.pushSystemMessage(`oauth: launching chrome.identity for ${oauthSlug}`, {
					"data-mcp-event": "oauth-popup-opened",
					"data-mcp-slug": oauthSlug,
				});
				const responseUrl = await new Promise<string>((resolve, reject) => {
					chromeIdentity!.launchWebAuthFlow!({ url: urlToOpen, interactive: true }, (rUrl: string | undefined) => {
						const err = (globalThis as { chrome?: { runtime?: { lastError?: { message?: string } } } })
							.chrome?.runtime?.lastError;
						if (err) reject(new Error(err.message ?? "chrome.identity error"));
						else if (!rUrl) reject(new Error("chrome.identity returned no responseUrl"));
						else resolve(rUrl);
					});
				});
				const cb = new URL(responseUrl);
				cbCode = cb.searchParams.get("code") ?? "";
				cbState = cb.searchParams.get("state") ?? "";
			} else {
				const completion = new Promise<{ code: string; state: string }>((resolve) => {
					const onMsg = (e: MessageEvent) => {
						if (e.origin !== window.location.origin) return;
						const data = e.data as { kind?: string; code?: string; state?: string };
						if (data?.kind !== "bodhi-pi-oauth-callback" || !data.code || !data.state) return;
						if (data.state !== startResp.state) return;
						window.removeEventListener("message", onMsg);
						resolve({ code: data.code, state: data.state });
					};
					window.addEventListener("message", onMsg);
				});
				window.open(urlToOpen, "oauth", "popup=yes,width=500,height=600");
				ctx.pushSystemMessage(`oauth: opened popup for ${oauthSlug}`, {
					"data-mcp-event": "oauth-popup-opened",
					"data-mcp-slug": oauthSlug,
				});
				const r = await completion;
				cbCode = r.code;
				cbState = r.state;
			}
			const finishResp = (await ctx.conn.extMethod(EXT_MCP_OAUTH_FINISH, {
				slug: oauthSlug,
				code: cbCode,
				state: cbState,
			})) as { status: string; errorMessage?: string };
			ctx.pushSystemMessage(
				finishResp.status === "completed"
					? `oauth: completed ${oauthSlug}`
					: `oauth: failed ${oauthSlug}: ${finishResp.errorMessage ?? "unknown"}`,
				{
					"data-mcp-event": finishResp.status === "completed" ? "oauth-completed" : "oauth-failed",
					"data-mcp-slug": oauthSlug,
				},
			);
		} else if (sub === "tools") {
			const result = (await ctx.conn.extMethod(EXT_MCP_TOOLS, {
				sessionId: ctx.state.sessionId,
				slug,
			})) as { tools: string[] };
			if (result.tools.length === 0) {
				ctx.pushSystemMessage(`(no tools — is ${slug} connected and included?)`, {
					"data-mcp-event": "tools-empty",
					"data-mcp-slug": slug,
				});
			} else {
				ctx.pushSystemMessage(`tools for ${slug}:\n  ${result.tools.join("\n  ")}`, {
					"data-mcp-event": "tools",
					"data-mcp-slug": slug,
					"data-mcp-tool-count": String(result.tools.length),
				});
			}
		} else {
			ctx.pushSystemMessage(`unknown /mcp sub-command: ${sub}`);
		}
	} catch (err) {
		ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
	}
	return { handled: true };
}

