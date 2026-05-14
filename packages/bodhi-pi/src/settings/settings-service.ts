import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentHelpers } from "@/acp/_helpers.js";
import {
	EXT_SESSION_SETTINGS_GET,
	EXT_SESSION_SETTINGS_LIST,
	EXT_SESSION_SETTINGS_SET,
	EXT_SESSION_SETTINGS_UNSET,
} from "@/acp/constants.js";
import type { SessionState } from "@/acp/session-state.js";
import type { EventDispatcher } from "@/events/dispatcher.js";
import type { Filesystem } from "@/filesystem/filesystem.js";
import type { BodhiPiProjectSettings } from "./settings.js";
import { mergeSettings } from "./settings-merge.js";
import {
	getAt,
	parseDottedKey,
	parseSettingValue,
	type SettingsScope,
	setAt,
	unsetAt,
	unsetGlobalSetting,
	unsetProjectSetting,
	writeGlobalSetting,
	writeProjectSetting,
} from "./settings-writer.js";

type ExtHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface SettingsServiceDeps {
	filesystem: Filesystem;
	globalFilesystem?: Filesystem;
	homeDir?: string;
	events: EventDispatcher;
	helpers: AgentHelpers;
}

/**
 * Bundles the four `_bodhi-pi/session/settings/*` ext-method handlers. Owns scope parsing,
 * the three-layer merge, and the global/project filesystem writes.
 */
export class SettingsService {
	private readonly filesystem: Filesystem;
	private readonly globalFilesystem: Filesystem | undefined;
	private readonly homeDir: string | undefined;
	private readonly events: EventDispatcher;
	private readonly helpers: AgentHelpers;

	constructor(deps: SettingsServiceDeps) {
		this.filesystem = deps.filesystem;
		this.globalFilesystem = deps.globalFilesystem;
		this.homeDir = deps.homeDir;
		this.events = deps.events;
		this.helpers = deps.helpers;
	}

	register(): Array<[string, ExtHandler]> {
		return [
			[EXT_SESSION_SETTINGS_GET, this.handleSettingsGet.bind(this)],
			[EXT_SESSION_SETTINGS_SET, this.handleSettingsSet.bind(this)],
			[EXT_SESSION_SETTINGS_UNSET, this.handleSettingsUnset.bind(this)],
			[EXT_SESSION_SETTINGS_LIST, this.handleSettingsList.bind(this)],
		];
	}

	private parseScope(method: string, raw: unknown, defaultScope: SettingsScope): SettingsScope {
		if (raw === undefined) return defaultScope;
		if (raw === "global" || raw === "project" || raw === "session") return raw;
		throw new RequestError(-32602, `${method}: scope must be one of "global"|"project"|"session"`);
	}

	private assertGlobalSupported(method: string): string {
		if (!this.homeDir) {
			throw new RequestError(
				-32602,
				`${method}: --global scope not supported on this runtime; use --project or --session`,
			);
		}
		return this.homeDir;
	}

	private effectiveSettings(session: SessionState): BodhiPiProjectSettings {
		return mergeSettings(
			mergeSettings(session.settings.globalSettings ?? {}, session.settings.projectSettings),
			session.settings.sessionOverrides,
		);
	}

	private sourceForKey(session: SessionState, dotted: string): SettingsScope | "default" {
		const path = parseDottedKey(dotted);
		if (path.length === 0) return "default";
		if (getAt(session.settings.sessionOverrides as Record<string, unknown>, path) !== undefined) return "session";
		if (getAt(session.settings.projectSettings as Record<string, unknown>, path) !== undefined) return "project";
		if (getAt((session.settings.globalSettings ?? {}) as Record<string, unknown>, path) !== undefined)
			return "global";
		return "default";
	}

	private async handleSettingsGet(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const session = this.helpers.requireSession(EXT_SESSION_SETTINGS_GET, params);
		const key = this.helpers.requireStringParam(EXT_SESSION_SETTINGS_GET, params, "key");
		const scope = this.parseScope(EXT_SESSION_SETTINGS_GET, params.scope, "session");
		const path = parseDottedKey(key);
		let source: Record<string, unknown> = {};
		const resolvedScope: SettingsScope | "default" | "effective" = scope;
		if (scope === "global") {
			this.assertGlobalSupported(EXT_SESSION_SETTINGS_GET);
			source = (session.settings.globalSettings ?? {}) as Record<string, unknown>;
		} else if (scope === "project") {
			source = session.settings.projectSettings as Record<string, unknown>;
		} else {
			source = session.settings.sessionOverrides as Record<string, unknown>;
		}
		const value = getAt(source, path);
		const effectiveValue = getAt(this.effectiveSettings(session) as Record<string, unknown>, path);
		const effectiveSource = this.sourceForKey(session, key);
		return {
			key,
			scope: resolvedScope,
			value: value ?? null,
			effective: effectiveValue ?? null,
			source: effectiveSource,
		};
	}

	private async handleSettingsSet(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const session = this.helpers.requireSession(EXT_SESSION_SETTINGS_SET, params);
		const key = this.helpers.requireStringParam(EXT_SESSION_SETTINGS_SET, params, "key");
		if (!("value" in params)) {
			throw new RequestError(-32602, `${EXT_SESSION_SETTINGS_SET}: value is required`);
		}
		const value = typeof params.value === "string" ? parseSettingValue(params.value) : params.value;
		const scope = this.parseScope(EXT_SESSION_SETTINGS_SET, params.scope, "session");
		const path = parseDottedKey(key);

		if (scope === "global") {
			const homeDir = this.assertGlobalSupported(EXT_SESSION_SETTINGS_SET);
			const fs = this.globalFilesystem ?? this.filesystem;
			const updated = await writeGlobalSetting(fs, homeDir, key, value);
			session.settings.globalSettings = updated;
		} else if (scope === "project") {
			const updated = await writeProjectSetting(this.filesystem, session.cwd, key, value);
			session.settings.projectSettings = updated;
			session.settings.projectSettingsPresent = true;
		} else {
			session.settings.sessionOverrides = setAt(
				session.settings.sessionOverrides as Record<string, unknown>,
				path,
				value,
			) as BodhiPiProjectSettings;
		}

		await this.events.emit({
			type: "settings_change",
			sessionId: params.sessionId as string,
			scope,
			key,
			value,
			reason: "set",
		});

		return {
			key,
			scope,
			effective: getAt(this.effectiveSettings(session) as Record<string, unknown>, path) ?? null,
		};
	}

	private async handleSettingsUnset(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const session = this.helpers.requireSession(EXT_SESSION_SETTINGS_UNSET, params);
		const key = this.helpers.requireStringParam(EXT_SESSION_SETTINGS_UNSET, params, "key");
		const scope = this.parseScope(EXT_SESSION_SETTINGS_UNSET, params.scope, "session");
		const path = parseDottedKey(key);

		if (scope === "global") {
			const homeDir = this.assertGlobalSupported(EXT_SESSION_SETTINGS_UNSET);
			const fs = this.globalFilesystem ?? this.filesystem;
			const updated = await unsetGlobalSetting(fs, homeDir, key);
			session.settings.globalSettings = updated;
		} else if (scope === "project") {
			const updated = await unsetProjectSetting(this.filesystem, session.cwd, key);
			session.settings.projectSettings = updated;
		} else {
			session.settings.sessionOverrides = unsetAt(
				session.settings.sessionOverrides as Record<string, unknown>,
				path,
			) as BodhiPiProjectSettings;
		}

		await this.events.emit({
			type: "settings_change",
			sessionId: params.sessionId as string,
			scope,
			key,
			value: null,
			reason: "unset",
		});

		return {
			key,
			scope,
			effective: getAt(this.effectiveSettings(session) as Record<string, unknown>, path) ?? null,
		};
	}

	private async handleSettingsList(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const session = this.helpers.requireSession(EXT_SESSION_SETTINGS_LIST, params);
		const raw = params.scope;
		const scope: SettingsScope | "effective" =
			raw === undefined || raw === "effective"
				? "effective"
				: this.parseScope(EXT_SESSION_SETTINGS_LIST, raw, "session");
		if (scope === "global") this.assertGlobalSupported(EXT_SESSION_SETTINGS_LIST);
		const settings =
			scope === "global"
				? (session.settings.globalSettings ?? {})
				: scope === "project"
					? session.settings.projectSettings
					: scope === "session"
						? session.settings.sessionOverrides
						: this.effectiveSettings(session);
		return {
			scope,
			settings: settings as Record<string, unknown>,
		};
	}
}
