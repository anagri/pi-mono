import type { AvailableCommand, ClientSideConnection, SessionConfigOption } from "@agentclientprotocol/sdk";
import {
	EXT_MCP_ADD,
	EXT_MCP_CONNECT,
	EXT_MCP_DISCONNECT,
	EXT_MCP_EXCLUDE,
	EXT_MCP_INCLUDE,
	EXT_MCP_LIST,
	EXT_MCP_OAUTH_DISCOVER,
	EXT_MCP_OAUTH_FINISH,
	EXT_MCP_OAUTH_REGISTER,
	EXT_MCP_OAUTH_START,
	EXT_MCP_RECONNECT,
	EXT_MCP_REMOVE,
	EXT_MCP_TOOLS,
	EXT_SUBAGENT_CHILDREN,
	EXT_SUBAGENT_LIST,
	EXT_SUBAGENT_RUN,
	parseMcpAddArgs,
	type SubagentProfileSummary,
} from "@bodhiapp/bodhi-pi";
import { onOauthStatusEvent } from "./oauth-event-bus.ts";

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
const MODE_CONFIG_ID = "mode";
const EXT_SESSION_FORK = "_bodhi-pi/session/fork";
const EXT_SESSION_CLONE = "_bodhi-pi/session/clone";

export type AgentModeString = "ask" | "plan" | "edit" | "allow-all";

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
	setCurrentMode(id: AgentModeString): void;
	currentMode?: AgentModeString;
	availableModes?: AgentModeString[];
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

export function extractModeFromConfigOptions(
	options: SessionConfigOption[] | null | undefined,
): AgentModeString | undefined {
	if (!options) return undefined;
	for (const opt of options) {
		if (opt.id === MODE_CONFIG_ID && typeof opt.currentValue === "string") {
			return opt.currentValue as AgentModeString;
		}
	}
	return undefined;
}

export function extractAvailableModes(options: SessionConfigOption[] | null | undefined): AgentModeString[] {
	if (!options) return [];
	for (const opt of options) {
		if (opt.id === MODE_CONFIG_ID && opt.type === "select") {
			return (opt.options ?? []).map((o) => (o as { value: string }).value as AgentModeString);
		}
	}
	return [];
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

		case "/modes": {
			const modes = ctx.availableModes ?? [];
			if (modes.length === 0) {
				ctx.pushSystemMessage("(no modes advertised — try /new first)");
			} else {
				const lines = ["modes:"];
				for (const m of modes) {
					const marker = m === ctx.currentMode ? "*" : " ";
					lines.push(`${marker} ${m}`);
				}
				ctx.pushSystemMessage(lines.join("\n"));
			}
			return { handled: true };
		}

		case "/mode": {
			const modeId = parts[1];
			if (!modeId) {
				ctx.pushSystemMessage(`current mode: ${ctx.currentMode ?? "(unknown)"}`);
				return { handled: true };
			}
			try {
				const result = await ctx.conn.setSessionConfigOption({
					sessionId: ctx.state.sessionId,
					configId: MODE_CONFIG_ID,
					value: modeId,
				});
				const next = extractModeFromConfigOptions(result.configOptions);
				if (next) ctx.setCurrentMode(next);
				ctx.pushSystemMessage(`mode switched to: ${next ?? modeId}`, {
					"data-mode-event": "mode-set",
					"data-mode-value": next ?? modeId,
				});
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

		case "/agents": {
			try {
				const result = (await ctx.conn.extMethod(EXT_SUBAGENT_LIST, { sessionId: ctx.state.sessionId })) as {
					profiles: SubagentProfileSummary[];
				};
				if (result.profiles.length === 0) {
					ctx.pushSystemMessage("(no sub-agent profiles in .bodhi-pi/agents/)", { "data-subagent-event": "list-empty" });
				} else {
					const lines = ["agents:"];
					for (const p of result.profiles) lines.push(`  ${p.name}  ${p.description}`);
					ctx.pushSystemMessage(lines.join("\n"), {
						"data-subagent-event": "list",
						"data-subagent-count": String(result.profiles.length),
					});
				}
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/subagent": {
			const sub = parts[1];
			if (sub === "children") {
				try {
					const result = (await ctx.conn.extMethod(EXT_SUBAGENT_CHILDREN, {
						sessionId: ctx.state.sessionId,
					})) as { children: Array<{ sessionId: string; subagent?: { profileName: string } }> };
					if (result.children.length === 0) {
						ctx.pushSystemMessage("(no sub-agent runs from this session)", {
							"data-subagent-event": "children-empty",
						});
					} else {
						const lines = ["sub-agent runs:"];
						for (const c of result.children) {
							lines.push(`  ${c.sessionId}  ${c.subagent?.profileName ?? "(unknown)"}`);
						}
						ctx.pushSystemMessage(lines.join("\n"), {
							"data-subagent-event": "children",
							"data-subagent-count": String(result.children.length),
						});
					}
				} catch (err) {
					ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
				}
				return { handled: true };
			}
			const agent = parts[1];
			const taskParts = parts.slice(2);
			if (!agent || taskParts.length === 0) {
				ctx.pushSystemMessage("usage: /subagent <name> <task...>  |  /subagent children");
				return { handled: true };
			}
			const task = line.trim().slice(`/subagent ${agent} `.length);
			try {
				const result = (await ctx.conn.extMethod(EXT_SUBAGENT_RUN, {
					sessionId: ctx.state.sessionId,
					agent,
					task,
				})) as {
					childSessionId: string;
					status: string;
					summary?: string;
					durationMs: number;
					toolCount: number;
					error?: string;
				};
				const lines = [
					`sub-agent ${agent}: ${result.status} (${result.durationMs}ms, ${result.toolCount} tool calls)`,
					`childSessionId: ${result.childSessionId}`,
				];
				if (result.summary) lines.push("", result.summary);
				if (result.error) lines.push("", `error: ${result.error}`);
				ctx.pushSystemMessage(lines.join("\n"), {
					"data-subagent-event": "run-result",
					"data-subagent-name": agent,
					"data-subagent-status": result.status,
					"data-subagent-child-session-id": result.childSessionId,
				});
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
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
			const action = rest[0];
			if (action === "discover") {
				const url = rest[1];
				if (!url) {
					ctx.pushSystemMessage("usage: /mcp oauth discover <mcp-url>");
					return { handled: true };
				}
				const result = (await ctx.conn.extMethod(EXT_MCP_OAUTH_DISCOVER, { url })) as {
					authorizationServerUrl?: string;
					authorizeUrl?: string;
					tokenUrl?: string;
					registrationEndpoint?: string;
					scopesSupported?: string[];
					resource?: string;
				};
				const attrs: Record<string, string> = { "data-mcp-event": "oauth-discover" };
				if (result.authorizationServerUrl) attrs["data-mcp-auth-server"] = result.authorizationServerUrl;
				if (result.authorizeUrl) attrs["data-mcp-authorize-url"] = result.authorizeUrl;
				if (result.tokenUrl) attrs["data-mcp-token-url"] = result.tokenUrl;
				if (result.registrationEndpoint) attrs["data-mcp-registration-endpoint"] = result.registrationEndpoint;
				if (result.scopesSupported) attrs["data-mcp-scopes-supported"] = result.scopesSupported.join(" ");
				if (result.resource) attrs["data-mcp-resource"] = result.resource;
				const lines = [`oauth-discover: authorizationServer=${result.authorizationServerUrl ?? "(none)"}`];
				if (result.authorizeUrl) lines.push(`  authorize: ${result.authorizeUrl}`);
				if (result.tokenUrl) lines.push(`  token:     ${result.tokenUrl}`);
				if (result.registrationEndpoint) lines.push(`  register:  ${result.registrationEndpoint}`);
				if (result.scopesSupported) lines.push(`  scopes:    ${result.scopesSupported.join(" ")}`);
				if (result.resource) lines.push(`  resource:  ${result.resource}`);
				ctx.pushSystemMessage(lines.join("\n"), attrs);
				return { handled: true };
			}
			if (action === "register") {
				const registrationEndpoint = rest[1];
				const redirectUri = rest[2];
				if (!registrationEndpoint || !redirectUri) {
					ctx.pushSystemMessage("usage: /mcp oauth register <registration-endpoint> <redirect-uri> [--scopes=a,b]");
					return { handled: true };
				}
				const scopesFlag = rest.slice(3).find((a) => a.startsWith("--scopes="));
				const scopes = scopesFlag ? scopesFlag.slice("--scopes=".length).split(",") : undefined;
				const result = (await ctx.conn.extMethod(EXT_MCP_OAUTH_REGISTER, {
					registrationEndpoint,
					redirectUri,
					...(scopes ? { scopes } : {}),
				})) as {
					clientId: string;
					clientSecret?: string;
					tokenEndpointAuthMethod?: string;
					registrationAccessToken?: string;
				};
				const attrs: Record<string, string> = {
					"data-mcp-event": "oauth-registered",
					"data-mcp-client-id": result.clientId,
				};
				if (result.tokenEndpointAuthMethod) attrs["data-mcp-token-auth-method"] = result.tokenEndpointAuthMethod;
				const lines = [
					`oauth-register: clientId=${result.clientId}`,
					`  clientSecret: ${result.clientSecret ? `<set, ${result.clientSecret.length} chars>` : "(none — public client)"}`,
				];
				if (result.tokenEndpointAuthMethod) lines.push(`  authMethod:   ${result.tokenEndpointAuthMethod}`);
				ctx.pushSystemMessage(lines.join("\n"), attrs);
				return { handled: true };
			}
			const oauthSlug = rest[1];
			const auto = rest.slice(2).includes("--auto");
			if (action !== "start" || !oauthSlug) {
				ctx.pushSystemMessage("usage: /mcp oauth <discover <url>|register <regUrl> <redirectUri>|start <slug>>");
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
			// Two completion paths race here so the slash works across all runtimes:
			//   - postMessage path (browser / chrome-ext: redirect_uri = ${origin}/oauth/callback,
			//     popup is our React route which postMessages to opener)
			//   - lifecycle-event path (HTTP+WS: redirect_uri = ${server}/oauth/callback, server
			//     completes silently and emits `mcp_oauth_status_change` over SSE/WS)
			// chrome-ext takes its own branch — chrome.identity blocks and returns the redirect URL.
			let cbCode: string | undefined;
			let cbState: string | undefined;
			let serverCompleted = false;
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
				const completion = new Promise<
					| { source: "postmessage"; code: string; state: string }
					| { source: "server"; status: "completed" | "failed"; errorMessage?: string }
					| { source: "event" }
				>((resolve) => {
					const onMsg = (e: MessageEvent) => {
						const data = e.data as {
							kind?: string;
							code?: string;
							state?: string;
							slug?: string;
							status?: string;
							errorMessage?: string;
						};
						// Path A: browser popup React route — we own the page, so origin must match.
						if (data?.kind === "bodhi-pi-oauth-callback" && data.code && data.state) {
							if (e.origin !== window.location.origin) return;
							if (data.state !== startResp.state) return;
							cleanup();
							resolve({ source: "postmessage", code: data.code, state: data.state });
							return;
						}
						// Path B: HTTP/WS server-side /oauth/callback finished the flow itself; the popup's
						// inline script postMessages us a "done" marker (no code/state — already exchanged
						// for tokens server-side). Origin filter is intentionally loose: the redirect lands
						// on the server's origin which may differ from the app's origin, and the slug match
						// is the load-bearing identity check (the popup couldn't know our slug without the
						// server having validated the state token first).
						if (
							data?.kind === "bodhi-pi-oauth-callback-done" &&
							data.slug === oauthSlug &&
							(data.status === "completed" || data.status === "failed")
						) {
							cleanup();
							resolve({
								source: "server",
								status: data.status,
								...(data.errorMessage !== undefined ? { errorMessage: data.errorMessage } : {}),
							});
							return;
						}
					};
					const offEvent = onOauthStatusEvent((event) => {
						if (event.slug !== oauthSlug) return;
						if (event.status !== "completed" && event.status !== "failed") return;
						cleanup();
						resolve({ source: "event" });
					});
					const cleanup = () => {
						window.removeEventListener("message", onMsg);
						offEvent();
					};
					window.addEventListener("message", onMsg);
				});
				window.open(urlToOpen, "oauth", "popup=yes,width=500,height=600");
				ctx.pushSystemMessage(`oauth: opened popup for ${oauthSlug}`, {
					"data-mcp-event": "oauth-popup-opened",
					"data-mcp-slug": oauthSlug,
				});
				const r = await completion;
				if (r.source === "postmessage") {
					cbCode = r.code;
					cbState = r.state;
				} else if (r.source === "server") {
					// HTTP/WS server-side /oauth/callback finished the flow; tokens already persisted.
					// Skip the follow-up oauth/finish call.
					if (r.status === "failed") {
						ctx.pushSystemMessage(`oauth: failed ${oauthSlug}: ${r.errorMessage ?? "server-side error"}`, {
							"data-mcp-event": "oauth-failed",
							"data-mcp-slug": oauthSlug,
						});
						return { handled: true };
					}
					serverCompleted = true;
				} else {
					// Lifecycle event path (future server-side push via SSE/WS); same skip.
					serverCompleted = true;
				}
			}
			if (serverCompleted) {
				ctx.pushSystemMessage(`oauth: completed ${oauthSlug}`, {
					"data-mcp-event": "oauth-completed",
					"data-mcp-slug": oauthSlug,
				});
			} else {
				const finishResp = (await ctx.conn.extMethod(EXT_MCP_OAUTH_FINISH, {
					slug: oauthSlug,
					code: cbCode!,
					state: cbState!,
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
			}
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

