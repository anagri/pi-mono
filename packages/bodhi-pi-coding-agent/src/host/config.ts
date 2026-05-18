import os from "node:os";
import path from "node:path";

export const APP_NAME = "bodhi-pi-coding-agent";
export const APP_DIR = `.${APP_NAME}`;

export function defaultDbPath(): string {
	return path.join(os.homedir(), APP_DIR, "sessions.db");
}

export function defaultKvDir(): string {
	return path.join(os.homedir(), APP_DIR, "kv");
}

export function homeDir(): string {
	return os.homedir();
}
