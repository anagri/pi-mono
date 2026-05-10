/**
 * Auto-resume scoping. Key = `(origin, userId)` so different tenants on the
 * same browser can't cross-contaminate, and parallel test workers (each on
 * their own port) get isolated last-session storage.
 */
const PREFIX = "bodhi-pi-http:lastSession";

function key(origin: string, userId: number | string): string {
	return `${PREFIX}:${origin}:${userId}`;
}

function currentOrigin(): string {
	if (typeof window === "undefined") return "";
	return window.location.origin;
}

export function read(userId: number | string): string | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage.getItem(key(currentOrigin(), userId));
	} catch {
		return null;
	}
}

export function write(userId: number | string, sessionId: string): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(key(currentOrigin(), userId), sessionId);
	} catch {
		// ignore
	}
}

export function clear(userId: number | string): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.removeItem(key(currentOrigin(), userId));
	} catch {
		// ignore
	}
}
