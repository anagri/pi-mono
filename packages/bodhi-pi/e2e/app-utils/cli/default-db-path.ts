import os from "node:os";
import path from "node:path";

export function defaultDbPath(appDirName = "bodhi-pi"): string {
	return path.join(os.homedir(), `.${appDirName}`, "sessions.db");
}
